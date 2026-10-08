import { describe, expect, it } from "vitest";
import {
	coerceFigures, figureNoteBounds, figureToken, parseFigureFence, stripFigureTokens, stripTokens,
	strokesInFigure,
} from "./NoteFigures";
import { MAX_FIGURES } from "./CodexLimits";

describe("figure detection parsing", () => {
	it("splits Codex's answer into Markdown and the figures its fence declares", () => {
		const answer = "Intro text\n\n%%figure-1%%\n\nMore text\n\n```figures\n" +
			'[{"id":1,"box":[0.1,0.2,0.6,0.7]}]\n```';
		const { markdown, figures } = parseFigureFence(answer);
		expect(markdown).toBe("Intro text\n\n%%figure-1%%\n\nMore text");
		expect(figures).toEqual([{ id: 1, box: { left: 0.1, top: 0.2, right: 0.6, bottom: 0.7 } }]);
	});

	it("strips stray tokens when no fence declares them, so no marker leaks into a note", () => {
		const { markdown, figures } = parseFigureFence("Before\n\n%%figure-1%%\n\nafter");
		expect(figures).toEqual([]);
		expect(markdown).toBe("Before\n\nafter");
	});

	it("normalizes tokens: first occurrence kept on its own line, duplicates dropped, missing appended", () => {
		const answer = "A %%figure-1%% B %%figure-1%% C\n\n```figures\n" +
			'[{"id":1,"box":[0,0,1,1]},{"id":2,"box":[0,0,0.5,0.5]}]\n```';
		const { markdown } = parseFigureFence(answer);
		expect(markdown.match(/%%figure-1%%/g)).toHaveLength(1);
		// Its own line, so the embed that replaces it becomes a standalone block.
		expect(markdown).toMatch(/(^|\n)%%figure-1%%(\n|$)/);
		// Figure 2 had a box but no marker: it still needs a place to land.
		expect(markdown.endsWith("%%figure-2%%")).toBe(true);
	});

	it("drops malformed boxes and caps the figure count instead of trusting the model", () => {
		expect(coerceFigures([
			{ id: 1, box: [0.2, 0.2, 0.1, 0.9] },          // left >= right
			{ id: 2, box: [0, 0, 1, 2] },                  // out of range
			{ id: 3, box: [0, 0, 1] },                     // wrong arity
			{ id: 3.5, box: [0, 0, 1, 1] },                // non-integer id
			{ id: 4, box: [0.1, 0.1, 0.9, 0.9] },          // valid
			{ id: 4, box: [0.1, 0.1, 0.9, 0.9] },          // duplicate id
			"junk",
		])).toEqual([{ id: 4, box: { left: 0.1, top: 0.1, right: 0.9, bottom: 0.9 } }]);
		expect(coerceFigures("not an array")).toEqual([]);
		const many = Array.from({ length: MAX_FIGURES + 3 }, (_, index) => ({ id: index + 1, box: [0, 0, 1, 1] }));
		expect(coerceFigures(many)).toHaveLength(MAX_FIGURES);
	});
});

describe("figure geometry", () => {
	const section = { left: 100, top: 200, right: 300, bottom: 600 };

	it("maps a fractional box back to padded note coordinates, clamped to the section", () => {
		const bounds = figureNoteBounds(section, { left: 0.5, top: 0.25, right: 1, bottom: 0.5 });
		// Model boxes are coarse: the 3% pad keeps a grazing axis line inside.
		expect(bounds.left).toBeCloseTo(100 + 0.5 * 200 - Math.max(8, 200 * 0.03));
		expect(bounds.top).toBeCloseTo(200 + 0.25 * 400 - Math.max(8, 400 * 0.03));
		expect(bounds.right).toBe(300);
		expect(bounds.bottom).toBeCloseTo(200 + 0.5 * 400 + Math.max(8, 400 * 0.03));
	});

	it("claims a stroke by its centre, so a long tail outside the box does not lose it", () => {
		const inside = { bounds: { left: 110, top: 210, right: 150, bottom: 260 } };
		const tail = { bounds: { left: 90, top: 190, right: 160, bottom: 280 } };
		const outside = { bounds: { left: 250, top: 500, right: 290, bottom: 590 } };
		expect(strokesInFigure([inside, tail, outside], { left: 100, top: 200, right: 180, bottom: 300 }))
			.toEqual([inside, tail]);
	});
});

describe("token stripping", () => {
	it("removes given tokens and collapses the blank lines they leave", () => {
		expect(stripTokens("A\n\n%%figure-hw1%%\n\nB", ["%%figure-hw1%%"])).toBe("A\n\nB");
	});
	it("strips every figure token for the copy path, where no embed file exists", () => {
		expect(stripFigureTokens("A\n\n%%figure-2%%\n\n%%figure-hw9%%\n\nB")).toBe("A\n\nB");
	});
	it("builds the token the prompt and the rewrite share", () => {
		expect(figureToken(3)).toBe("%%figure-3%%");
		expect(figureToken("hw7")).toBe("%%figure-hw7%%");
	});
});
