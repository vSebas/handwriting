import { describe, expect, it } from "vitest";
import type { InkStroke } from "../ink/Stroke";
import type { MathEditor } from "./MathInsertionTarget";
import { appendTranscription, captureWholeNoteTarget, imageSelectionBounds, noteInkSnapshot } from "./WholeNoteInk";

function stroke(id: string, x: number, y: number, tool: "pen" | "highlighter" = "pen"): InkStroke {
	return { id, tool, color: "black", width: 2, createdAt: Number(id.replace(/\D/g, "")) || 1,
		bbox: { x, y, width: 8, height: 12 }, points: [
			{ x, y, t: 0, pressure: .5 }, { x: x + 8, y: y + 12, t: 20, pressure: .5 },
		] };
}

describe("whole-note ink transcription", () => {
	it("keeps every pen stroke in one image and maps visual selection to note coordinates", () => {
		const strokes = [stroke("s1", 0, 0), stroke("s2", 30, 0), stroke("s3", 0, 90), stroke("h", 0, 45, "highlighter")];
		const snapshot = noteInkSnapshot(strokes);
		expect(snapshot.ink.traces).toHaveLength(3);
		const crop = imageSelectionBounds(snapshot.bounds, [.1, .2], [.9, .8]);
		expect(crop.left).toBeLessThan(crop.right);
		expect(crop.top).toBeLessThan(crop.bottom);
		expect(imageSelectionBounds(snapshot.bounds, [1, 1], [0, 0])).toEqual(snapshot.bounds);
		strokes[0]!.points[0]!.x = 999;
		expect(snapshot.ink.traces[0]![0]![0]).toBe(0);
	});
	it("accepts long rasterizable lines beyond the lasso model's point limit", () => {
		const long = stroke("s1", 0, 0);
		long.points = Array.from({ length: 2_500 }, (_, i) => ({ x: i / 10, y: i % 12, t: i, pressure: .5 }));
		expect(noteInkSnapshot([long]).ink.traces[0]).toHaveLength(2_500);
	});
	it("never changes existing Markdown, pasted images, or their paths", () => {
		const original = "# Notes\n\nExisting paragraph.\n\n![[Pasted image 2026.png]]\n";
		const updated = appendTranscription(original, "Text\n\n$$\nx^2\n$$");
		expect(updated.startsWith(original)).toBe(true);
		expect(updated.slice(original.length)).toBe("\n## Handwriting transcription\n\nText\n\n$$\nx^2\n$$\n");
	});
	it("appends through the same active editor at the current end without replacing a selection", () => {
		let body = "![[image.png]]\n";
		let edit: { text: string; from: number; to: number } | undefined;
		const file = {} as MathEditor["file"];
		const editor = { getValue: () => body, offsetToPos: (offset: number) => ({ line: 0, ch: offset }),
			replaceRange: (text: string, from: { ch: number }, to: { ch: number }) => {
				edit = { text, from: from.ch, to: to.ch };
				body = body.slice(0, from.ch) + text + body.slice(to.ch);
			} } as unknown as NonNullable<MathEditor["editor"]>;
		const active = { editor, file };
		const append = captureWholeNoteTarget(active, () => active);
		body += "New typing\n";
		append("recognized text");
		expect(edit?.from).toBe("![[image.png]]\nNew typing\n".length);
		expect(edit?.to).toBe(edit?.from);
		expect(body).toContain("![[image.png]]\nNew typing\n\n## Handwriting transcription");
		expect(() => append("again")).toThrow("already been appended");
	});
	it("refuses changing the target note and empty results", () => {
		expect(() => appendTranscription("x", "  ")).toThrow("nonempty");
		const editor = {} as NonNullable<MathEditor["editor"]>;
		const file = {} as MathEditor["file"];
		const append = captureWholeNoteTarget({ editor, file }, () => null);
		expect(() => append("text")).toThrow("original note");
	});
});
