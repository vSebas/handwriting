import { describe, expect, it } from "vitest";
import { beamSearch } from "./BeamSearch";

const SOS = 0, EOS = 1, A = 2, B = 3, C = 4;
function harness(scores: (prefix: number[]) => number[], maxSteps = 5) {
	const created: { prefix: number[] }[] = [{ prefix: [] }];
	const disposed = new Set<object>();
	let maxAlive = 1;
	const run = () => beamSearch({
		initialState: created[0]!, startToken: SOS, endToken: EOS, maxSteps,
		allowedToken: id => id !== SOS,
		decode: async (last, _step, state) => {
			expect(disposed.has(state)).toBe(false);
			const prefix = last === SOS ? [] : [...state.prefix, last];
			const next = { prefix };
			const logits = scores(prefix);
			created.push(next);
			maxAlive = Math.max(maxAlive, created.length - disposed.size);
			return { logits, state: next };
		},
		dispose: state => { expect(disposed.has(state)).toBe(false); disposed.add(state); },
	});
	return { run, created, disposed, maxAlive: () => maxAlive };
}

describe("candidate beam decoding", () => {
	it("recovers a stronger full expression after a weaker first token", async () => {
		const h = harness(prefix => !prefix.length ? [-Infinity, -Infinity, Math.log(.6), Math.log(.4), -Infinity]
			: prefix.length === 1 && prefix[0] === A ? [-Infinity, Math.log(.1), Math.log(.3), Math.log(.3), Math.log(.3)]
			: [-Infinity, 0, -Infinity, -Infinity, -Infinity]);
		const result = await h.run();
		expect(result[0]!.tokenIds).toEqual([B]);
		expect(result).toHaveLength(3);
		expect(h.disposed.size).toBe(h.created.length);
		expect(h.maxAlive()).toBeLessThanOrEqual(6);
	});
	it("shares a parent cache safely between siblings and never emits special tokens", async () => {
		const h = harness(prefix => !prefix.length ? [100, 100, 3, 2, 1] : [-Infinity, 0, -Infinity, -Infinity, -Infinity]);
		expect((await h.run()).map(c => c.tokenIds)).toEqual([[A], [B], [C]]);
		expect(h.disposed.size).toBe(h.created.length);
	});
	it("returns only finished expressions when another beam reaches the limit", async () => {
		const h = harness(prefix => !prefix.length ? [-Infinity, -Infinity, 1, 0, -Infinity]
			: prefix[0] === A ? [-Infinity, 0, -Infinity, -Infinity, -Infinity]
			: [-Infinity, -Infinity, 0, -Infinity, -Infinity], 3);
		expect((await h.run()).map(c => c.tokenIds)).toEqual([[A]]);
		expect(h.disposed.size).toBe(h.created.length);
	});
	it("does not present truncated output as a complete expression", async () => {
		const h = harness(() => [-Infinity, -Infinity, 0, -Infinity, -Infinity], 3);
		expect(await h.run()).toEqual([]);
		expect(h.disposed.size).toBe(h.created.length);
	});
	it("releases shared states if inference throws", async () => {
		const h = harness(prefix => { if (prefix.length) throw new Error("decoder failed"); return [-Infinity, -Infinity, 1, 0, -Infinity]; });
		await expect(h.run()).rejects.toThrow("decoder failed");
		expect(h.disposed.size).toBe(h.created.length);
	});
	it("releases caches and rejects invalid numeric scores", async () => {
		const h = harness(() => [NaN, 0, 0]);
		await expect(h.run()).rejects.toThrow("Invalid recognition scores");
		expect(h.disposed.size).toBe(h.created.length);
	});
});
