import type { Editor, TFile } from "obsidian";
import type { InkStroke } from "../ink/Stroke";
import type { MathInk, TracePoint } from "./MathRecognition";
import { inkImageBounds, type InkImageBounds } from "./MathInkImage";

export interface MathEditor { editor?: Editor; file: TFile | null }

export interface NotePlacementAnchor { offset: number; y: number; label: string }
export interface NoteStrokeSnapshot {
	id: string;
	signature: string;
	trace: TracePoint[];
	bounds: InkImageBounds;
}
export interface NoteInkSource { ink: MathInk; bounds: InkImageBounds; strokes: NoteStrokeSnapshot[]; anchors: NotePlacementAnchor[] }
export interface NoteInkSection { ink: MathInk; bounds: InkImageBounds; strokes: NoteStrokeSnapshot[]; anchor: NotePlacementAnchor }

/** A single immutable image source: no stroke-based word or line segmentation. */
export function noteInkSnapshot(strokes: readonly InkStroke[], anchors: NotePlacementAnchor[] = []): NoteInkSource {
	const pens = strokes.filter(stroke => stroke.tool === "pen" && stroke.points.length);
	if (!pens.length) throw new Error("This note has no pen handwriting to convert.");
	if (pens.length > 1200 || pens.reduce((n, stroke) => n + stroke.points.length, 0) > 120_000) {
		throw new Error("This note has too much pen ink for one image. Use a smaller lasso selection.");
	}
	const ordered = [...pens].sort((a, b) => a.createdAt - b.createdAt);
	const ink = snapshotInk(ordered);
	const raw = inkImageBounds(ink);
	const pad = Math.max(12, Math.min(40, (raw.right - raw.left) * .02));
	const snapshots = ordered.map((stroke, index) => ({ id: stroke.id, signature: JSON.stringify(stroke),
		trace: ink.traces[index]!, bounds: inkImageBounds({ traces: [ink.traces[index]!] }) }));
	return { ink, strokes: snapshots, anchors: [...anchors].sort((a, b) => a.y - b.y),
		bounds: { left: raw.left - pad, top: raw.top - pad, right: raw.right + pad, bottom: raw.bottom + pad } };
}

/** Markdown blocks are the only automatic separators; pen gaps never split words. */
export function noteInkSections(source: NoteInkSource, selection: InkImageBounds): NoteInkSection[] {
	const intersects = (a: InkImageBounds, b: InkImageBounds) => a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;
	const selected = source.strokes.filter(stroke => intersects(stroke.bounds, selection));
	if (!selected.length) throw new Error("The selected area contains no pen handwriting.");
	const start = [...source.anchors].reverse().find(anchor => anchor.y <= selection.top) ??
		source.anchors[0] ?? { offset: 0, y: -Infinity, label: "Start of note" };
	const boundaries = source.anchors.filter(anchor => anchor.y > selection.top && anchor.y < selection.bottom &&
		!selected.some(stroke => stroke.bounds.top - 8 <= anchor.y && stroke.bounds.bottom + 8 >= anchor.y));
	const groups = new Map<NotePlacementAnchor, NoteStrokeSnapshot[]>();
	for (const stroke of selected) {
		const center = (stroke.bounds.top + stroke.bounds.bottom) / 2;
		let anchor = start;
		for (const candidate of boundaries) if (candidate.y <= center) anchor = candidate;
		const group = groups.get(anchor) ?? [];
		group.push(stroke);
		groups.set(anchor, group);
	}
	return [...groups].map(([anchor, strokes]) => {
		const ink = { traces: strokes.map(stroke => stroke.trace) };
		const raw = inkImageBounds(ink);
		const pad = 12;
		return { ink, strokes, anchor, bounds: {
			left: Math.max(selection.left, raw.left - pad), right: Math.min(selection.right, raw.right + pad),
			top: Math.max(selection.top, raw.top - pad), bottom: Math.min(selection.bottom, raw.bottom + pad),
		} };
	}).sort((a, b) => a.bounds.top - b.bounds.top);
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
	const traces = strokes.map(stroke => {
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

/** Safe insertion points after complete Markdown blocks, including image embeds. */
export function markdownBlockAnchors(markdown: string): Array<{ offset: number; lineStart: number; label: string }> {
	const lines = markdown.split("\n");
	const starts: number[] = [];
	let offset = 0;
	for (const line of lines) { starts.push(offset); offset += line.length + 1; }
	let first = 0;
	if (lines[0] === "---") {
		const end = lines.findIndex((line, index) => index > 0 && line === "---");
		if (end > 0) first = end + 1;
	}
	const result = [{ offset: starts[first] ?? markdown.length, lineStart: starts[Math.max(0, first - 1)] ?? 0,
		label: first ? "After properties" : "Start of note" }];
	let blockStart = -1;
	const finish = (end: number) => {
		if (blockStart < 0) return;
		const label = lines[blockStart]!.trim().slice(0, 48);
		result.push({ offset: starts[end + 1] ?? markdown.length, lineStart: starts[end]!, label: `After: ${label}` });
		blockStart = -1;
	};
	let fence: string | null = null;
	let mathBlock = false;
	for (let index = first; index < lines.length; index++) {
		const line = lines[index]!.trim();
		const marker = /^(?:`{3,}|~{3,})/.exec(line)?.[0] ?? null;
		if (fence) {
			if (marker !== null && marker[0] === fence[0] && marker.length >= fence.length) { fence = null; finish(index); }
			continue;
		}
		if (marker) { finish(index - 1); blockStart = index; fence = marker; continue; }
		if (line === "$$") {
			if (mathBlock) { mathBlock = false; finish(index); }
			else { finish(index - 1); blockStart = index; mathBlock = true; }
			continue;
		}
		if (mathBlock) continue;
		const standalone = /^!\[\[.+\]\]$|^!\[[^\]]*\]\([^)]*\)$/.test(line);
		if (!line) { finish(index - 1); continue; }
		if (standalone) { finish(index - 1); blockStart = index; finish(index); continue; }
		if (blockStart < 0) blockStart = index;
	}
	finish(lines.length - 1);
	return result.filter((entry, index) => index === 0 || entry.offset > result[index - 1]!.offset);
}

export type NotePlacement = "sections" | "cursor" | "end";
export interface TranscriptionBlock { markdown: string; offset: number }

/** Only insert text; the caller removes reviewed pen strokes after insertion succeeds. */
export function captureWholeNoteInsertionTarget(active: MathEditor, current: () => MathEditor | null):
	(blocks: TranscriptionBlock[], placement: NotePlacement, combined: string) => void {
	const editor = active.editor, file = active.file;
	if (!editor || !file) throw new Error("Open a Markdown editor to insert the transcription.");
	const original = editor.getValue();
	const cursor = editor.posToOffset(editor.getCursor());
	let inserted = false;
	return (blocks, placement, combined) => {
		if (inserted) throw new Error("This transcription has already been inserted.");
		const now = current();
		if (now?.editor !== editor || now.file !== file) throw new Error("Return to the original note before inserting, or copy the transcription.");
		const body = editor.getValue();
		if (placement !== "end" && body !== original) throw new Error("The note changed while recognition ran. Copy the result or reopen this dialog.");
		const items = placement === "sections" ? blocks : [{ markdown: combined, offset: placement === "cursor" ? cursor : body.length }];
		if (!items.length || items.reduce((length, item) => length + item.markdown.length, 0) > 100_000 ||
			items.some(item => !item.markdown.trim() || !Number.isInteger(item.offset) || item.offset < 0 || item.offset > body.length)) {
			throw new Error("Review a nonempty transcription and a valid insertion point.");
		}
		const grouped = new Map<number, string[]>();
		for (const item of items) grouped.set(item.offset, [...(grouped.get(item.offset) ?? []), item.markdown.trim()]);
		for (const [at, values] of [...grouped].sort((a, b) => b[0] - a[0])) {
			const before = body.slice(0, at), after = body.slice(at);
			const prefix = !before ? "" : before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
			const suffix = !after ? "\n" : after.startsWith("\n\n") ? "" : after.startsWith("\n") ? "\n" : "\n\n";
			const position = editor.offsetToPos(at);
			editor.replaceRange(prefix + values.join("\n\n") + suffix, position, position);
		}
		inserted = true;
	};
}
