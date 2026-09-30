import { describe, expect, it } from "vitest";
import { noteInkTiles } from "./MathInkImage";

const doc = { createElement: () => {
	const canvas = { width: 0, height: 0, getContext: () => ({
		fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, arc() {}, fill() {},
	}), toDataURL() { return `image-${canvas.width}x${canvas.height}`; } };
	return canvas;
} } as unknown as Document;

describe("whole-note image tiling", () => {
	it("keeps a short area together and gives long areas an overview plus detail tiles", () => {
		const ink = { traces: [[[10, 10, 0], [20, 3000, 1]]] as [number, number, number][][] };
		expect(noteInkTiles(ink, { left: 0, top: 0, right: 800, bottom: 900 }, doc)).toHaveLength(1);
		const images = noteInkTiles(ink, { left: 0, top: 0, right: 800, bottom: 3500 }, doc);
		expect(images).toHaveLength(4);
		expect(images[0]).toContain("image-");
		expect(images.slice(1).every(image => {
			const [, width, height] = /^image-(\d+)x(\d+)$/.exec(image) ?? [];
			return Number(width) <= 1568 && Number(height) <= 1568;
		})).toBe(true);
	});
	it("requires a smaller selection when too many detail tiles would be needed", () => {
		expect(() => noteInkTiles({ traces: [[[0, 0, 0]]] },
			{ left: 0, top: 0, right: 5000, bottom: 5000 }, doc)).toThrow("smaller");
	});
});
