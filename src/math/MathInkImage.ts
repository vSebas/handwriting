import type { MathInk } from "./MathRecognition";

/** Render only selected paths, independently of note background, zoom and theme. */
export function mathInkImage(ink: MathInk, doc: Document = document): string {
	let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
	for (const trace of ink.traces) for (const [x, y] of trace) {
		if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("The selected ink contains invalid coordinates.");
		left = Math.min(left, x); right = Math.max(right, x);
		top = Math.min(top, y); bottom = Math.max(bottom, y);
	}
	if (!Number.isFinite(left)) throw new Error("Select a handwritten expression first.");
	const width = right - left, height = bottom - top;
	if (!Number.isFinite(width) || !Number.isFinite(height)) throw new Error("The selected ink is too large.");
	const scale = Math.min(2, 1568 / Math.max(width, height, 1));
	const canvas = doc.createElement("canvas");
	canvas.width = Math.max(32, Math.ceil(width * scale) + 32);
	canvas.height = Math.max(32, Math.ceil(height * scale) + 32);
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
			const px = (x - left) * scale + 16, py = (y - top) * scale + 16;
			if (index === 0) context.moveTo(px, py); else context.lineTo(px, py);
		});
		context.stroke();
		// A pen tap is a dot; a zero-length path alone is not painted by canvas.
		const [x, y] = trace[0]!;
		context.beginPath();
		context.arc((x - left) * scale + 16, (y - top) * scale + 16, context.lineWidth / 2, 0, 2 * Math.PI);
		context.fill();
	}
	return canvas.toDataURL("image/png");
}
