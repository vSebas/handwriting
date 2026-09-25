import { describe, expect, it } from "vitest";
import type { InkStroke } from "../ink/Stroke";
import { mathInk } from "./MathRecognition";
import { extractFeatures } from "./HandToTexFeatures";

const stroke = (id: string, tool: "pen" | "highlighter", createdAt: number): InkStroke => ({
	id, tool, createdAt, width: 2, color: "#000", bbox: { x: 0, y: 0, width: 10, height: 20 },
	points: [{ x: 0, y: 0, t: 0, pressure: .5 }, { x: 10, y: 20, t: 50, pressure: .5 }],
});

describe("Handwriting selection to Hand-to-TeX input", () => {
	it("snapshots pen strokes in writing order and reconstructs relative timing", () => {
		const original = [stroke("later", "pen", 200), stroke("highlight", "highlighter", 0), stroke("first", "pen", 100)];
		const ink = mathInk(original);
		expect(ink.traces).toEqual([[[0, 0, 0], [10, 20, 50]], [[0, 0, 100], [10, 20, 150]]]);
		expect(original.map(s => s.id)).toEqual(["later", "highlight", "first"]);
		original[2]!.points[0]!.x = 999;
		expect(ink.traces[0]![0]![0]).toBe(0);
	});
	it("refuses empty, highlight-only, invalid and oversized selections", () => {
		for (const strokes of [[], [stroke("h", "highlighter", 0)], [stroke("p", "pen", NaN)], Array.from({ length: 201 }, (_, i) => stroke(String(i), "pen", i))]) expect(() => mathInk(strokes)).toThrow();
		const large = stroke("large", "pen", 10);
		large.points = Array.from({ length: 2049 }, () => ({ x: 0, y: 0, t: 0, pressure: .5 }));
		expect(() => mathInk([large])).toThrow("2,048");
	});
	it("extracts the pretrained model's 12 features with stroke-start flags", () => {
		const { flatData, numPoints, numFeatures } = extractFeatures([[[0, 0, 0], [10, 10, 10]], [[20, 20, 20]]]);
		expect(numFeatures).toBe(12);
		expect(numPoints).toBe(3);
		expect(flatData.length).toBe(36);
		expect([flatData[9], flatData[21], flatData[33]]).toEqual([1, 0, 1]);
		expect(flatData[0]).toBe(0);
		expect(flatData[24]).toBeCloseTo(1);
		expect(flatData.every(Number.isFinite)).toBe(true);
	});
	it("handles dots and equal timestamps without nonfinite tensors", () => {
		expect(extractFeatures([[[1, 1, 0], [1, 1, 0]]]).flatData.every(Number.isFinite)).toBe(true);
	});
});
