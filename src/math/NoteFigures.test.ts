import { describe, expect, it } from "vitest";
import {
	FigureContractError, coerceFigures, figureNoteBounds, figureToken, opaqueFigureSvg,
	parseFigureFence, stripFigureTokens, stripTokens, strokesInFigure,
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

	it("fails loudly on a marker with no declaration instead of silently losing the figure", () => {
		// A stripped marker's drawing would be deleted as transcribed text
		// under replace-ink, so the contract break fails the transcription.
		expect(() => parseFigureFence("Before\n\n%%figure-1%%\n\nafter")).toThrow(FigureContractError);
		expect(() => parseFigureFence("Text\n\n```figures\nnot json\n```")).toThrow(FigureContractError);
		// No markers and no fence is simply a note without figures.
		expect(parseFigureFence("Just text")).toEqual({ markdown: "Just text", figures: [] });
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

	it("clamps rounding slips, dedupes repeats, and throws on anything it would have to drop", () => {
		// A dropped declaration would delete its drawing under replace-ink,
		// so only harmless deviations degrade; the rest fail the parse.
		expect(coerceFigures([
			{ id: 1, box: [-0.01, 0, 1.02, 0.5] },         // rounding slip: clamped
			{ id: 1, box: [0, 0, 1, 1] },                  // duplicate id: first wins
		])).toEqual([{ id: 1, box: { left: 0, top: 0, right: 1, bottom: 0.5 } }]);
		for (const broken of [
			[{ id: 2, box: [0.2, 0.2, 0.1, 0.9] }],        // left >= right
			[{ id: 3, box: [0, 0, 1] }],                   // wrong arity
			[{ id: 3.5, box: [0, 0, 1, 1] }],              // non-integer id
			["junk"],
			"not an array",
			Array.from({ length: MAX_FIGURES + 1 }, (_, index) => ({ id: index + 1, box: [0, 0, 1, 1] })),
		]) {
			expect(() => coerceFigures(broken), JSON.stringify(broken).slice(0, 48)).toThrow(FigureContractError);
		}
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

describe("opaque figure embeds", () => {
	it("backs a figure SVG with a white rect spanning its viewBox, origin included", () => {
		// Transparent dark-stroke embeds vanish on a dark theme; an embed is
		// an image and has to read like one everywhere.
		expect(opaqueFigureSvg('<svg xmlns="x" viewBox="-12 -8 40 24"><path d="M0 0"/></svg>'))
			.toBe('<svg xmlns="x" viewBox="-12 -8 40 24"><rect x="-12" y="-8" width="40" height="24" fill="#ffffff"/><path d="M0 0"/></svg>');
	});
	it("falls back to a full-viewport rect without a parseable viewBox", () => {
		expect(opaqueFigureSvg('<svg width="10" height="10"><path d="M0 0"/></svg>'))
			.toContain('<rect width="100%" height="100%" fill="#ffffff"/>');
		expect(opaqueFigureSvg('<svg viewBox="a b c d"><path d="M0 0"/></svg>'))
			.toContain('<rect width="100%" height="100%" fill="#ffffff"/>');
	});
	it("replaces an existing backdrop instead of stacking or trusting it", () => {
		const once = opaqueFigureSvg('<svg viewBox="0 0 4 4"><path d="M0 0"/></svg>');
		expect(opaqueFigureSvg(once)).toBe(once);
		// A revision that grew the viewBox while keeping the old backdrop
		// would leave the new area transparent; the rect must track the box.
		expect(opaqueFigureSvg('<svg viewBox="0 0 200 100"><rect x="0" y="0" width="100" height="100" fill="#ffffff"/><path d="M0 0"/></svg>'))
			.toBe('<svg viewBox="0 0 200 100"><rect x="0" y="0" width="200" height="100" fill="#ffffff"/><path d="M0 0"/></svg>');
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
