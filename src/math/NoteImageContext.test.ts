import { describe, expect, it } from "vitest";
import { declaredImagePixels, embeddedImageLinks, sectionContextRange } from "./NoteImageContext";
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

	it("never uploads an embed that only appears inside code or comments", () => {
		// A literal ![[private.png]] in an example does not RENDER an embed,
		// so it must not quietly send that vault file to Codex.
		const hidden = [
			"```md", "![[in-fence.png]]", "```",
			"Inline `![[in-code.png]]` span.",
			"%%![[in-comment.png]]%%",
			"<!-- ![[in-html.png]] -->",
			"![[visible.png]]",
			"~~~", "![[unterminated.png]]",
		].join("\n");
		expect(embeddedImageLinks(hidden, 0, null)).toEqual(["visible.png"]);
	});
});

describe("context image safety", () => {
	it("reads declared pixels from PNG and JPEG headers before any decode", () => {
		// A decompression bomb passes the byte cap and OOMs the renderer at
		// bitmap creation, before any best-effort catch can run.
		const png = new Uint8Array(32);
		new DataView(png.buffer).setUint32(0, 0x89504e47);
		new DataView(png.buffer).setUint32(16, 20_000);
		new DataView(png.buffer).setUint32(20, 20_000);
		expect(declaredImagePixels(png)).toBe(400_000_000);
		// Minimal JPEG: SOI, then an SOF0 segment declaring 300 x 200.
		const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x00, 0xc8, 0x03, 0, 0, 0, 0, 0, 0, 0, 0]);
		expect(declaredImagePixels(jpeg)).toBe(300 * 200);
		expect(declaredImagePixels(new Uint8Array([1, 2, 3]))).toBeNull();
	});

	it("a section's range starts one anchor back, where the copied image lives", () => {
		// Anchors mark where a block ENDS, so with slide A | handwriting |
		// slide B the sketch's source A sits BEFORE the section's anchor.
		expect(sectionContextRange([0, 40, 90], 40)).toEqual({ from: 0, to: 90 });
		expect(sectionContextRange([0, 40, 90], 0)).toEqual({ from: 0, to: 40 });
		expect(sectionContextRange([0, 40, 90], 90)).toEqual({ from: 40, to: null });
		expect(sectionContextRange([], 10)).toEqual({ from: 0, to: null });
	});
});
