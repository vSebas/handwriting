/**
 * Drawn-figure detection and safety, shared by the bridge and both review
 * modals.
 *
 * The transcription prompt asks Codex to mark each drawn figure (plot,
 * diagram, sketch) with a `%%figure-N%%` token in the Markdown and to append
 * ONE fenced `figures` block declaring each figure's bounding box as
 * fractions of the overview image. This module owns that contract: parsing
 * and normalizing what the model actually returns (parseFigureFence), mapping
 * a declared box back to note coordinates (figureNoteBounds), deciding which
 * strokes a figure claims (strokesInFigure), and scrubbing a Codex-drawn SVG
 * before it becomes a vault file (sanitizeFigureSvg).
 *
 * Everything but the sanitizer is pure string/geometry work with no DOM, so
 * it loads under node vitest; the sanitizer touches DOMParser only inside the
 * function body, never at module scope.
 */

import type { InkImageBounds } from "./MathInkImage";
import { FIGURE_SVG_MAX_CHARS, MAX_FIGURES } from "./CodexLimits";

/** Fractions of the overview image: 0..1, left<right, top<bottom. */
export interface FigureBox { left: number; top: number; right: number; bottom: number }
export interface DetectedFigure { id: number; box: FigureBox }

export const figureToken = (id: number | string): string => `%%figure-${id}%%`;
/** Matches server-numbered tokens AND the client's rewritten unique ones. */
const TOKEN_PATTERN = /%%figure-([A-Za-z0-9-]+)%%/g;

/** A figure list, validated instead of trusted: malformed boxes and duplicate
 * ids are dropped, and the count is capped at MAX_FIGURES. The box may be the
 * model's fence shape ([l,t,r,b]) or the bridge's parsed shape ({left,...}). */
export function coerceFigures(value: unknown): DetectedFigure[] {
	if (!Array.isArray(value)) return [];
	const out: DetectedFigure[] = [];
	const seen = new Set<number>();
	for (const entry of value) {
		if (out.length === MAX_FIGURES) break;
		const id = (entry as { id?: unknown })?.id;
		const raw = (entry as { box?: unknown })?.box;
		const sides = Array.isArray(raw) && raw.length === 4 ? raw
			: raw && typeof raw === "object"
				? [(raw as FigureBox).left, (raw as FigureBox).top, (raw as FigureBox).right, (raw as FigureBox).bottom]
				: null;
		if (!Number.isInteger(id) || (id as number) < 1 || seen.has(id as number) || !sides ||
			sides.some(n => typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 1)) continue;
		const [left, top, right, bottom] = sides as [number, number, number, number];
		if (left >= right || top >= bottom) continue;
		seen.add(id as number);
		out.push({ id: id as number, box: { left, top, right, bottom } });
	}
	return out;
}

/**
 * Split Codex's answer into Markdown and its declared figures, and normalize
 * the tokens so downstream code can rely on them: each declared figure
 * appears EXACTLY once, on its own line (so the embed that replaces it is a
 * standalone block); duplicates are dropped; a declared figure with no marker
 * is appended at the end (it still needs a place to land); a marker with no
 * declaration is stripped (no token may ever leak into a note).
 */
export function parseFigureFence(answer: string): { markdown: string; figures: DetectedFigure[] } {
	const trimmed = answer.trim();
	const fence = /(?:^|\n)(`{3,}|~{3,})figures[ \t]*\n([\s\S]*?)\n\1[ \t]*$/.exec(trimmed);
	let figures: DetectedFigure[] = [];
	let markdown = trimmed;
	if (fence) {
		markdown = trimmed.slice(0, fence.index).trim();
		try { figures = coerceFigures(JSON.parse(fence[2]!)); } catch { /* An unparseable fence means no figures. */ }
	}
	const declared = new Set(figures.map(figure => String(figure.id)));
	const seen = new Set<string>();
	markdown = markdown.replace(TOKEN_PATTERN, (token, id: string) => {
		if (!declared.has(id) || seen.has(id)) return "";
		seen.add(id);
		return `\n\n${token}\n\n`;
	});
	for (const figure of figures) {
		if (!seen.has(String(figure.id))) markdown += `\n\n${figureToken(figure.id)}`;
	}
	return { markdown: collapseBlanks(markdown), figures };
}

/** Remove specific tokens (a figure kept as pen ink inserts nothing). */
export function stripTokens(text: string, tokens: readonly string[]): string {
	for (const token of tokens) text = text.split(token).join("");
	return collapseBlanks(text);
}

/** Remove EVERY figure token: the copy path, where no embed file exists. */
export function stripFigureTokens(text: string): string {
	return collapseBlanks(text.replace(TOKEN_PATTERN, ""));
}

function collapseBlanks(text: string): string {
	return text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * A declared box back in note coordinates. Model boxes are coarse, so each
 * edge is padded by 3% of the section span (at least 8 note px) before being
 * clamped to the section - a grazing axis line still counts as the figure's.
 */
export function figureNoteBounds(section: InkImageBounds, box: FigureBox): InkImageBounds {
	const width = section.right - section.left, height = section.bottom - section.top;
	const padX = Math.max(8, width * 0.03), padY = Math.max(8, height * 0.03);
	return {
		left: Math.max(section.left, section.left + box.left * width - padX),
		right: Math.min(section.right, section.left + box.right * width + padX),
		top: Math.max(section.top, section.top + box.top * height - padY),
		bottom: Math.min(section.bottom, section.top + box.bottom * height + padY),
	};
}

/** A figure claims a stroke by its CENTRE: a long tail poking out of the box
 * (an axis, an arrow) does not lose the stroke to the surrounding text. */
export function strokesInFigure<T extends { bounds: InkImageBounds }>(strokes: readonly T[], figure: InkImageBounds): T[] {
	return strokes.filter(({ bounds }) => {
		const cx = (bounds.left + bounds.right) / 2, cy = (bounds.top + bounds.bottom) / 2;
		return cx >= figure.left && cx <= figure.right && cy >= figure.top && cy <= figure.bottom;
	});
}

/** Static shapes and text only. No script, no foreignObject (arbitrary HTML),
 * no image/use (external or recursive content), no animation. */
const SAFE_SVG_ELEMENTS = new Set([
	"svg", "g", "defs", "title", "desc", "path", "rect", "circle", "ellipse", "line",
	"polyline", "polygon", "text", "tspan", "marker", "linearGradient", "radialGradient",
	"stop", "clipPath",
]);

/**
 * Scrub a Codex-drawn SVG before it is previewed or written into the vault.
 * The model is INSTRUCTED to emit only static shapes, but a vault file may
 * later open in a real browser, so the output is enforced, not trusted:
 * disallowed elements are removed whole; event attributes, every kind of
 * href, and any non-fragment url() reference are dropped. Throws when what
 * remains is not a plausible figure. DOM access stays inside this function,
 * so the module still loads under node vitest.
 */
export function sanitizeFigureSvg(svg: string,
	parser: { parseFromString(text: string, type: DOMParserSupportedType): Document } = new DOMParser()): string {
	const text = svg.trim();
	if (text.length > FIGURE_SVG_MAX_CHARS) throw new Error("The redrawn figure is too large. Ask for a simpler redraw.");
	if (!text.startsWith("<svg") || !text.endsWith("</svg>") || /<!DOCTYPE|<!ENTITY|<\?/i.test(text)) {
		throw new Error("Codex did not return an SVG drawing. Ask for the redraw again.");
	}
	const doc = parser.parseFromString(text, "image/svg+xml");
	const root = doc.documentElement;
	if (root.localName !== "svg" || doc.getElementsByTagName("parsererror").length) {
		throw new Error("Codex returned invalid SVG markup. Ask for the redraw again.");
	}
	const scrub = (element: Element): void => {
		for (const name of element.getAttributeNames()) {
			const value = element.getAttribute(name) ?? "";
			if (/^on/i.test(name) || /href/i.test(name) || /url\(\s*["']?\s*(?!#)/i.test(value)) element.removeAttribute(name);
		}
		for (const child of [...element.children]) {
			if (SAFE_SVG_ELEMENTS.has(child.localName)) scrub(child);
			else child.remove();
		}
	};
	scrub(root);
	if (!root.hasAttribute("viewBox") && !(root.hasAttribute("width") && root.hasAttribute("height"))) {
		throw new Error("The redrawn figure declares no size. Ask for the redraw again.");
	}
	root.setAttribute("xmlns", "http://www.w3.org/2000/svg");
	return new XMLSerializer().serializeToString(root);
}
