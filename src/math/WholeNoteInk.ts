import type { InkStroke } from "../ink/Stroke";
import type { MathInk, TracePoint } from "./MathRecognition";
import type { MathEditor } from "./MathInsertionTarget";
import { inkImageBounds, type InkImageBounds } from "./MathInkImage";

/** A single immutable image source: no stroke-based word or line segmentation. */
export function noteInkSnapshot(strokes: readonly InkStroke[]): { ink: MathInk; bounds: InkImageBounds } {
	const pens = strokes.filter(stroke => stroke.tool === "pen" && stroke.points.length);
	if (!pens.length) throw new Error("This note has no pen handwriting to convert.");
	if (pens.length > 1200 || pens.reduce((n, stroke) => n + stroke.points.length, 0) > 120_000) {
		throw new Error("This note has too much pen ink for one image. Use a smaller lasso selection.");
	}
	const ink = snapshotInk([...pens]);
	const raw = inkImageBounds(ink);
	const pad = Math.max(12, Math.min(40, (raw.right - raw.left) * .02));
	return { ink, bounds: { left: raw.left - pad, top: raw.top - pad,
		right: raw.right + pad, bottom: raw.bottom + pad } };
}

/** Map a rectangle dragged over the preview back to original note coordinates. */
export function imageSelectionBounds(full: InkImageBounds, from: [number, number], to: [number, number]): InkImageBounds {
	const clamp = (n: number) => Math.max(0, Math.min(1, n));
	const x1 = clamp(Math.min(from[0], to[0])), x2 = clamp(Math.max(from[0], to[0]));
	const y1 = clamp(Math.min(from[1], to[1])), y2 = clamp(Math.max(from[1], to[1]));
	return { left: full.left + x1 * (full.right - full.left), right: full.left + x2 * (full.right - full.left),
		top: full.top + y1 * (full.bottom - full.top), bottom: full.top + y2 * (full.bottom - full.top) };
}

/** Copy note paths before any asynchronous model request. */
function snapshotInk(strokes: InkStroke[]): MathInk {
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
