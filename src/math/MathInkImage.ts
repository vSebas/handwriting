import type { MathInk } from "./MathRecognition";
import { MAX_TILES, RENDER_MAX_EDGE_PX, TILE_OVERLAP_PX, TILE_PX } from "./CodexLimits";

export interface InkImageBounds { left: number; top: number; right: number; bottom: number }

export function inkImageBounds(ink: MathInk): InkImageBounds {
	let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
	for (const trace of ink.traces) for (const [x, y] of trace) {
		if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("The selected ink contains invalid coordinates.");
		left = Math.min(left, x); right = Math.max(right, x);
		top = Math.min(top, y); bottom = Math.max(bottom, y);
	}
	if (!Number.isFinite(left)) throw new Error("Select some handwriting first.");
	return { left, top, right, bottom };
}

/** Render only selected paths, independently of note background, zoom and theme. */
export function mathInkImage(ink: MathInk, doc: Document = document): string {
	return renderInk(ink, inkImageBounds(ink), doc, 16);
}

/** Render a user-chosen rectangle at fresh resolution, independently of preview scale. */
export function noteInkImage(ink: MathInk, bounds: InkImageBounds, doc: Document = document): string {
	return renderInk(ink, bounds, doc, 0);
}

/** Keep a long note legible by sending ordered, overlapping images in one request. */
export function noteInkTiles(ink: MathInk, bounds: InkImageBounds, doc: Document = document): string[] {
	const width = bounds.right - bounds.left, height = bounds.bottom - bounds.top;
	if (width <= 0 || height <= 0) throw new Error("Select a visible area of handwriting.");
	const tile = TILE_PX, overlap = TILE_OVERLAP_PX, step = tile - overlap;
	const columns = Math.max(1, Math.ceil((width - overlap) / step));
	const rows = Math.max(1, Math.ceil((height - overlap) / step));
	if (rows * columns > MAX_TILES) throw new Error("This area needs more than eight images. Select a smaller part of the note.");
	const images: string[] = [];
	for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
		const left = Math.max(bounds.left, Math.min(bounds.left + column * step, bounds.right - tile));
		const top = Math.max(bounds.top, Math.min(bounds.top + row * step, bounds.bottom - tile));
		images.push(noteInkImage(ink, { left, top,
			right: Math.min(bounds.right, left + tile), bottom: Math.min(bounds.bottom, top + tile) }, doc));
	}
	return images.length > 1 ? [noteInkImage(ink, bounds, doc), ...images] : images;
}

function renderInk(ink: MathInk, bounds: InkImageBounds, doc: Document, padding: number): string {
	const { left, top, right, bottom } = bounds;
	const width = right - left, height = bottom - top;
	if (!Number.isFinite(width) || !Number.isFinite(height) || width < 0 || height < 0 ||
		!Number.isFinite(left) || !Number.isFinite(top)) throw new Error("The selected ink bounds are invalid.");
	const scale = Math.min(2, RENDER_MAX_EDGE_PX / Math.max(width, height, 1));
	const canvas = doc.createElement("canvas");
	canvas.width = Math.max(1, Math.min(RENDER_MAX_EDGE_PX, Math.ceil(width * scale)) + padding * 2);
	canvas.height = Math.max(1, Math.min(RENDER_MAX_EDGE_PX, Math.ceil(height * scale)) + padding * 2);
	const context = canvas.getContext("2d");
	if (!context) throw new Error("Could not render the selected handwriting.");
	context.fillStyle = "white";
	context.fillRect(0, 0, canvas.width, canvas.height);
	context.strokeStyle = context.fillStyle = "black";
	context.lineCap = context.lineJoin = "round";
	context.lineWidth = Math.max(1, 2 * scale);
	for (const trace of ink.traces) {
		if (!trace.length) continue;
		context.beginPath();
		trace.forEach(([x, y], index) => {
			const px = (x - left) * scale + padding, py = (y - top) * scale + padding;
			if (index === 0) context.moveTo(px, py); else context.lineTo(px, py);
		});
		context.stroke();
		// A pen tap is a dot; a zero-length path alone is not painted by canvas.
		const [x, y] = trace[0]!;
		context.beginPath();
		context.arc((x - left) * scale + padding, (y - top) * scale + padding, context.lineWidth / 2, 0, 2 * Math.PI);
		context.fill();
	}
	return canvas.toDataURL("image/png");
}
