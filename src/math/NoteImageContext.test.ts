import { describe, expect, it } from "vitest";
import { embeddedImageLinks } from "./NoteImageContext";
import { MAX_NOTE_CONTEXT_IMAGES } from "./CodexLimits";

describe("note-embedded image links as redraw context", () => {
	const note = [
		"# Kinematics",            // offset 0
		"![[slide one.png|300]]",  // wiki embed with size
		"![alt](plots/v-t%20graph.jpg \"title\")",
		"![[Sketch.webp#heading]]",
		"![external](https://example.com/x.png)",
		"![[notes.pdf]]",          // not an image
		"![[slide one.png]]",      // duplicate target
	].join("\n");

	it("finds wiki and markdown vault images in a slice, deduped and in order", () => {
		expect(embeddedImageLinks(note, 0, null)).toEqual(["slide one.png", "plots/v-t graph.jpg"]);
	});

	it("ignores external URLs and non-image embeds entirely", () => {
		const links = embeddedImageLinks(note, 0, null);
		expect(links.some(link => link.includes("example.com") || link.endsWith(".pdf"))).toBe(false);
	});

	it("respects the slice bounds, so only the figure's own section contributes", () => {
		const start = note.indexOf("![[Sketch");
		expect(embeddedImageLinks(note, start, start + "![[Sketch.webp#heading]]".length))
			.toEqual(["Sketch.webp"]);
		expect(embeddedImageLinks(note, 0, start)).toEqual(["slide one.png", "plots/v-t graph.jpg"]);
	});

	it("caps how many images ride along", () => {
		const many = Array.from({ length: MAX_NOTE_CONTEXT_IMAGES + 2 }, (_, i) => `![[img-${i}.png]]`).join("\n");
		expect(embeddedImageLinks(many, 0, null)).toHaveLength(MAX_NOTE_CONTEXT_IMAGES);
	});
});
