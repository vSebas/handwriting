import type { InkStroke } from "../ink/Stroke";
import type { MathInk, TracePoint } from "./MathRecognition";
import type { MathEditor } from "./MathInsertionTarget";

export interface NoteInkRegion { ink: MathInk; strokes: number; x: number; y: number }

/** Group pen paths into horizontal bands. The user reviews every band before any note edit. */
export function noteInkRegions(strokes: readonly InkStroke[]): NoteInkRegion[] {
	const pens = strokes.filter(s => s.tool === "pen" && s.points.length);
	if (!pens.length) throw new Error("This note has no pen handwriting to convert.");
	if (pens.length > 1200) throw new Error("This note has more than 1,200 pen strokes. Convert smaller selections with the lasso.");
	if (pens.reduce((n, stroke) => n + stroke.points.length, 0) > 120_000) {
		throw new Error("This note has more than 120,000 ink points. Convert smaller selections with the lasso.");
	}
	const bounds = pens.map(stroke => {
		let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
		for (const point of stroke.points) {
			if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error("The note contains invalid ink coordinates.");
			left = Math.min(left, point.x); right = Math.max(right, point.x);
			top = Math.min(top, point.y); bottom = Math.max(bottom, point.y);
		}
		return { stroke, left, right, top, bottom, center: (top + bottom) / 2, height: bottom - top };
	});
	const heights = bounds.map(b => b.height).filter(h => h > 1).sort((a, b) => a - b);
	const typical = heights[Math.floor(heights.length / 2)] ?? 18;
	const tolerance = Math.max(10, Math.min(60, typical * .8));
	const bands: { center: number; members: typeof bounds }[] = [];
	for (const bound of bounds.sort((a, b) => a.center - b.center || a.left - b.left)) {
		let nearest: typeof bands[number] | undefined;
		let distance = Infinity;
		for (const band of bands) {
			const d = Math.abs(band.center - bound.center);
			if (d < distance && d <= tolerance) { nearest = band; distance = d; }
		}
		if (nearest) {
			nearest.members.push(bound);
			nearest.center = nearest.members.reduce((sum, member) => sum + member.center, 0) / nearest.members.length;
		} else bands.push({ center: bound.center, members: [bound] });
	}
	if (bands.length > 100) throw new Error("This note has more than 100 handwriting regions. Convert smaller selections with the lasso.");
	return bands.map(band => {
		const members = band.members.sort((a, b) => a.left - b.left);
		return { ink: regionInk(members.map(m => m.stroke)), strokes: members.length,
			x: Math.min(...members.map(m => m.left)), y: Math.min(...members.map(m => m.top)) };
	}).sort((a, b) => a.y - b.y || a.x - b.x);
}

/** Whole-note crops are rasterized locally, so they need no small on-device encoder limit. */
function regionInk(strokes: InkStroke[]): MathInk {
	if (strokes.length > 300 || strokes.reduce((n, stroke) => n + stroke.points.length, 0) > 25_000) {
		throw new Error("One handwriting region is too dense to recognize. Convert that part with the lasso.");
	}
	let firstTime = Infinity;
	const traces = strokes.sort((a, b) => a.createdAt - b.createdAt).map(stroke => {
		const start = stroke.createdAt - stroke.points[stroke.points.length - 1]!.t;
		return stroke.points.map(point => {
			const time = start + point.t;
			if (!Number.isFinite(time)) throw new Error("The note contains invalid ink timestamps.");
			firstTime = Math.min(firstTime, time);
			return [point.x, point.y, time] as TracePoint;
		});
	});
	for (const trace of traces) for (const point of trace) point[2] -= firstTime;
	return { traces };
}

/** Append only. The original Markdown prefix, including image links, is byte-for-byte intact. */
export function appendTranscription(original: string, markdown: string): string {
	const result = markdown.replace(/\r\n?/g, "\n").trim();
	if (!result || result.length > 100_000) throw new Error("Review a nonempty transcription under 100,000 characters.");
	return original + (original ? original.endsWith("\n") ? "\n" : "\n\n" : "") + "## Handwriting transcription\n\n" + result + "\n";
}

/** Append at the current end of the same editor, even if its body changed while OCR ran. */
export function captureWholeNoteTarget(active: MathEditor, current: () => MathEditor | null): (markdown: string) => void {
	const editor = active.editor, file = active.file;
	if (!editor || !file) throw new Error("Open a Markdown editor to append the transcription.");
	let inserted = false;
	return markdown => {
		if (inserted) throw new Error("This transcription has already been appended.");
		const now = current();
		if (now?.editor !== editor || now.file !== file) throw new Error("Return to the original note before appending, or copy the transcription.");
		const original = editor.getValue();
		const suffix = appendTranscription(original, markdown).slice(original.length);
		const end = editor.offsetToPos(original.length);
		editor.replaceRange(suffix, end, end);
		inserted = true;
	};
}
