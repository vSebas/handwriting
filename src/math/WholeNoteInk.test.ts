import { describe, expect, it } from "vitest";
import type { InkStroke } from "../ink/Stroke";
import { captureWholeNoteInsertionTarget, imageSelectionBounds,
	markdownBlockAnchors, noteInkSections, noteInkSnapshot, type MathEditor } from "./WholeNoteInk";

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
	it("separates ink at intervening Markdown content, never at an ink-only word gap", () => {
		const anchors = [{ offset: 0, y: 0, label: "Start" }, { offset: 12, y: 120, label: "After image" }];
		const snapshot = noteInkSnapshot([stroke("s1", 0, 20), stroke("s2", 20, 20), stroke("s3", 0, 220)], anchors);
		const sections = noteInkSections(snapshot, snapshot.bounds);
		expect(sections.map(section => section.strokes.map(item => item.id))).toEqual([["s1", "s2"], ["s3"]]);
		expect(sections.map(section => section.anchor.offset)).toEqual([0, 12]);
		expect(noteInkSections(noteInkSnapshot([stroke("s1", 0, 20), stroke("s3", 0, 220)]), snapshot.bounds)).toHaveLength(1);
	});
	it("offers anchors around images without inserting inside properties or paragraphs", () => {
		const body = "---\nhandwriting-page-id: abc\n---\n# A\n\nBefore image\n![[diagram.png]]\nAfter image";
		const anchors = markdownBlockAnchors(body);
		expect(anchors[0]?.offset).toBe(body.indexOf("# A"));
		expect(anchors.map(anchor => anchor.label)).toContain("After: ![[diagram.png]]");
		const imageAnchor = anchors.find(anchor => anchor.label.includes("diagram"))!;
		expect(body.slice(imageAnchor.offset)).toBe("After image");
	});
	it("does not offer insertion points inside fenced code or display math", () => {
		const body = "Before\n\n```md\n![[not-an-embed.png]]\n\ncode\n```\n\n$$\n![[not-an-embed.png]]\n$$\n\nAfter";
		const anchors = markdownBlockAnchors(body);
		expect(anchors.filter(anchor => anchor.label.includes("not-an-embed"))).toHaveLength(0);
		expect(anchors.some(anchor => anchor.label === "After: ```md")).toBe(true);
		expect(anchors.some(anchor => anchor.label === "After: $$")).toBe(true);
	});
	it("inserts reviewed sections around existing text and images and captures the original cursor", () => {
		let body = "A\n\n![[image.png]]\n\nB";
		const original = body;
		const file = {} as MathEditor["file"];
		const editor = { getValue: () => body, getCursor: () => ({ line: 0, ch: 1 }), posToOffset: (pos: { ch: number }) => pos.ch,
			offsetToPos: (at: number) => ({ line: 0, ch: at }),
			replaceRange: (text: string, from: { ch: number }, to: { ch: number }) => { body = body.slice(0, from.ch) + text + body.slice(to.ch); },
		} as unknown as NonNullable<MathEditor["editor"]>;
		const active = { editor, file };
		const insert = captureWholeNoteInsertionTarget(active, () => active);
		insert([{ markdown: "first", offset: 1 }, { markdown: "second", offset: original.indexOf("B") }], "sections", "unused");
		expect(body).toContain("first\n\n![[image.png]]\n\nsecond");
		expect(body.replace(/first|second/g, "")).toContain("![[image.png]]");
		expect(() => insert([], "cursor", "again")).toThrow("already been inserted");
		body = original;
		const atCursor = captureWholeNoteInsertionTarget(active, () => active);
		atCursor([{ markdown: "ignored", offset: 0 }], "cursor", "cursor text");
		expect(body).toContain("A\n\ncursor text\n\n");
	});
	it("refuses stale note content before positional insertion", () => {
		let body = "Original";
		const file = {} as MathEditor["file"];
		const editor = { getValue: () => body, getCursor: () => ({ line: 0, ch: 0 }), posToOffset: () => 0 } as unknown as NonNullable<MathEditor["editor"]>;
		const active = { editor, file };
		const insert = captureWholeNoteInsertionTarget(active, () => active);
		body = "Changed";
		expect(() => insert([{ markdown: "new", offset: 0 }], "sections", "new")).toThrow("changed");
	});
});
