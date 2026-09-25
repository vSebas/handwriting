export interface BeamCandidate { tokenIds: number[]; logProbability: number }
interface Beam<State> extends BeamCandidate { state: State | null; last: number }

/** Bounded beam search. Sibling hypotheses share immutable decoder caches until pruning. */
export async function beamSearch<State>(options: {
	initialState: State;
	startToken: number;
	endToken: number;
	allowedToken: (id: number) => boolean;
	decode: (last: number, step: number, state: State) => Promise<{ logits: ArrayLike<number>; state: State }>;
	dispose: (state: State) => void;
	width?: number;
	maxSteps?: number;
}): Promise<BeamCandidate[]> {
	const width = options.width ?? 3;
	const maxSteps = options.maxSteps ?? 149;
	const owned = new Set<State>([options.initialState]);
	let beams: Beam<State>[] = [{ tokenIds: [], logProbability: 0, state: options.initialState, last: options.startToken }];
	// A modest length penalty reduces the preference for very short expressions.
	const score = (beam: BeamCandidate) => beam.logProbability / Math.pow((5 + beam.tokenIds.length + 1) / 6, 0.6);
	const pruneStates = (keep: Set<State>) => {
		for (const state of owned) if (!keep.has(state)) {
			owned.delete(state);
			options.dispose(state);
		}
	};
	try {
		for (let step = 0; step < maxSteps && beams.some(beam => beam.state !== null); step++) {
			const expanded: Beam<State>[] = [];
			for (const beam of beams) {
				if (beam.state === null) { expanded.push(beam); continue; }
				const output = await options.decode(beam.last, step, beam.state);
				owned.add(output.state);
				let max = -Infinity;
				for (let id = 0; id < output.logits.length; id++) {
					const value = output.logits[id]!;
					if (Number.isNaN(value) || value === Infinity) throw new Error("Invalid recognition scores.");
					max = Math.max(max, value);
				}
				if (!Number.isFinite(max)) throw new Error("No valid recognition scores.");
				let sum = 0;
				for (let id = 0; id < output.logits.length; id++) sum += Math.exp(output.logits[id]! - max);
				const logSum = Math.log(sum);
				const next: { id: number; logProbability: number }[] = [];
				for (let id = 0; id < output.logits.length; id++) {
					if (!Number.isFinite(output.logits[id]!) || !options.allowedToken(id) || (id === options.endToken && !beam.tokenIds.length)) continue;
					next.push({ id, logProbability: beam.logProbability + (output.logits[id]! - max) - logSum });
				}
				next.sort((a, b) => b.logProbability - a.logProbability || a.id - b.id);
				for (const token of next.slice(0, width)) {
					const ended = token.id === options.endToken;
					expanded.push({ tokenIds: ended ? beam.tokenIds : [...beam.tokenIds, token.id],
						logProbability: token.logProbability, last: token.id, state: ended ? null : output.state });
				}
			}
			expanded.sort((a, b) => score(b) - score(a));
			beams = expanded.slice(0, width);
			pruneStates(new Set(beams.flatMap(beam => beam.state === null ? [] : [beam.state])));
		}
		// Never present a prefix that failed to reach the end-of-expression token.
		return beams.filter(beam => beam.state === null).map(({ tokenIds, logProbability }) => ({ tokenIds, logProbability }));
	} finally {
		pruneStates(new Set());
	}
}
