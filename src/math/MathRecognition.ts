import type { InkStroke } from "../ink/Stroke";

export type TracePoint = [x: number, y: number, time: number];
export interface MathInk { traces: TracePoint[][] }
export interface MathResult { latex: string; candidates?: string[]; confidence?: number }

/** Copy the lasso's pen paths before any async work. Neither ink nor selection is modified. */
export function mathInk(strokes: readonly InkStroke[]): MathInk {
	const pens = strokes.filter(s => s.tool === "pen" && s.points.length > 0)
		.sort((a, b) => a.createdAt - b.createdAt);
	if (!pens.length) throw new Error("Lasso a handwritten expression first. Highlighter strokes are not recognized.");
	// Encoder attention grows quadratically; bound its memory use on iPads.
	if (pens.length > 200 || pens.reduce((n, s) => n + s.points.length, 0) > 2048) {
		throw new Error("Select a smaller expression (at most 200 strokes and 2,048 points).");
	}
	let firstTime = Infinity;
	const traces = pens.map(stroke => {
		const duration = stroke.points[stroke.points.length - 1]!.t;
		// createdAt records completion, while point.t is relative to pen-down.
		const start = stroke.createdAt - duration;
		return stroke.points.map(p => {
			const t = start + p.t;
			if (![p.x, p.y, t].every(Number.isFinite)) throw new Error("The selected ink contains invalid coordinates or timestamps.");
			firstTime = Math.min(firstTime, t);
			return [p.x, p.y, t] as TracePoint;
		});
	});
	for (const trace of traces) for (const point of trace) point[2] -= firstTime;
	return { traces };
}
