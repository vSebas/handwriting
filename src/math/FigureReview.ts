/**
 * The shared figure-review surface for both transcription modals.
 *
 * When Codex declares drawn figures, each one becomes a card with three
 * outcomes: embed the writer's own ink as an image (the default - nothing
 * invented, nothing lost), ask Codex to REDRAW it as clean SVG (gated behind
 * an explicit accept, with a request-changes loop that iterates on the
 * previous attempt), or keep it as pen ink and insert nothing. The choice
 * feeds collectFigureEmbeds at insert time, which decides what is embedded,
 * which strokes stay out of ink removal, and which tokens are stripped.
 *
 * reviewFiguresFor renders ink crops, so this module needs a DOM; it is
 * covered by the browser render suite, not the node unit suite.
 */

import { Setting, type ButtonComponent } from "obsidian";
import type { InkStroke } from "../ink/Stroke";
import { inkToSvg } from "../ink/SvgExport";
import { inkImageBounds, noteInkImage, type InkImageBounds } from "./MathInkImage";
import { figureNoteBounds, figureToken, stripTokens, strokesInFigure, type DetectedFigure } from "./NoteFigures";
import type { NoteStrokeSnapshot } from "./WholeNoteInk";

export type FigureChoice = "original" | "redraw" | "ink";
export interface FigureEmbed { token: string; svg: string }
export type FigureRedrawer = (image: string, feedback: string, previous: string, signal: AbortSignal,
	progress: (message: string) => void) => Promise<string>;

export interface ReviewFigure {
	/** The unique placeholder sitting in the reviewed Markdown. */
	token: string;
	/** PNG crop of the original ink: the card preview AND the redraw input. */
	image: string;
	/** Exact-ink SVG of the claimed strokes, the default embed. */
	svg: string;
	strokes: NoteStrokeSnapshot[];
	choice: FigureChoice;
	/** The latest Codex redraw, already sanitized by the redrawer. */
	redrawSvg: string | null;
	/** A redraw embeds ONLY once the user accepted it. */
	accepted: boolean;
	busy: boolean;
}

/**
 * Turn declared figures into reviewable ones: map each box to note
 * coordinates, claim the strokes inside it, and swap the model's numbered
 * token for a caller-unique one (two sections may both declare figure 1).
 * A box that claims no ink is a misdetection and is dropped whole.
 */
export function reviewFiguresFor(markdown: string, figures: readonly DetectedFigure[], bounds: InkImageBounds,
	strokes: readonly NoteStrokeSnapshot[], nextId: () => string, doc: Document = document):
	{ markdown: string; figures: ReviewFigure[] } {
	const out: ReviewFigure[] = [];
	for (const figure of figures) {
		const where = figureNoteBounds(bounds, figure.box);
		const claimed = strokesInFigure(strokes, where);
		const server = figureToken(figure.id);
		if (!claimed.length) { markdown = stripTokens(markdown, [server]); continue; }
		const token = figureToken(nextId());
		markdown = markdown.split(server).join(token);
		const ink = { traces: claimed.map(stroke => stroke.trace) };
		const raw = inkImageBounds(ink);
		const pad = 12;
		out.push({ token, strokes: claimed,
			image: noteInkImage(ink, { left: raw.left - pad, top: raw.top - pad, right: raw.right + pad, bottom: raw.bottom + pad }, doc),
			svg: inkToSvg(claimed.map(stroke => JSON.parse(stroke.signature) as InkStroke)),
			choice: "original", redrawSvg: null, accepted: false, busy: false });
	}
	return { markdown, figures: out };
}

/**
 * What the figures contribute to an insert. Throws while a chosen redraw is
 * still unaccepted: nothing Codex drew may reach a note unreviewed. A figure
 * whose token the user edited away behaves like "keep as ink" - no embed, and
 * its strokes stay out of removal.
 */
export function collectFigureEmbeds(figures: readonly ReviewFigure[], hasToken: (token: string) => boolean):
	{ embeds: FigureEmbed[]; keepInkIds: Set<string>; strip: string[] } {
	const embeds: FigureEmbed[] = [], strip: string[] = [], keepInkIds = new Set<string>();
	for (const figure of figures) {
		if (!hasToken(figure.token) || figure.choice === "ink") {
			for (const stroke of figure.strokes) keepInkIds.add(stroke.id);
			strip.push(figure.token);
			continue;
		}
		if (figure.choice === "redraw") {
			if (!figure.redrawSvg || !figure.accepted) {
				throw new Error("Accept the Codex redraw for each figure first, or switch it back to your own drawing.");
			}
			embeds.push({ token: figure.token, svg: figure.redrawSvg });
		} else embeds.push({ token: figure.token, svg: figure.svg });
	}
	return { embeds, keepInkIds, strip };
}

const svgDataUrl = (svg: string): string => "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);

/** One figure's card: preview, the three-way choice, and the redraw loop. */
export function renderFigureCard(host: HTMLElement, figure: ReviewFigure,
	redraw: FigureRedrawer | undefined, signal: AbortSignal): void {
	const card = host.createDiv({ cls: "handwriting-figure-result" });
	card.createEl("img", { attr: { src: figure.image, alt: "Detected drawn figure" } });
	new Setting(card).setName(`Drawn figure (${figure.strokes.length} strokes)`)
		.setDesc("Codex marked this as a drawing, not text. Choose what the inserted note shows where it sits.")
		.addDropdown(dropdown => {
			dropdown.addOption("original", "Embed my drawing as an image");
			if (redraw) dropdown.addOption("redraw", "Redraw with Codex (review first)");
			dropdown.addOption("ink", "Keep it as pen ink only");
			dropdown.setValue("original").onChange(value => {
				figure.choice = value === "redraw" ? "redraw" : value === "ink" ? "ink" : "original";
				paint();
			});
		});
	const review = card.createDiv({ cls: "handwriting-figure-redraw" });
	const status = review.createEl("p", { attr: { role: "status", "aria-live": "polite" } });
	const preview = review.createEl("img", { attr: { alt: "Codex redraw of the figure" } });
	const feedback = review.createEl("textarea", { attr: { "aria-label": "Describe what the redraw should change",
		rows: "2", placeholder: "What should change? e.g. the curve should pass through the origin" } });
	let requestButton!: ButtonComponent, acceptButton!: ButtonComponent, changesButton!: ButtonComponent;
	const run = async (text: string): Promise<void> => {
		if (figure.busy || !redraw) return;
		figure.busy = true;
		figure.accepted = false;
		paint();
		try {
			// A change request iterates on the previous redraw; the plain
			// redraw button always starts fresh from the original drawing.
			figure.redrawSvg = await redraw(figure.image, text, text ? figure.redrawSvg ?? "" : "",
				signal, message => status.setText(message));
			feedback.value = "";
			status.setText("Review the redraw: accept it, or describe a change and send it.");
		} catch (error) {
			status.setText(error instanceof Error ? error.message : "Redraw failed.");
		} finally {
			figure.busy = false;
			paint();
		}
	};
	new Setting(review)
		.addButton(button => { requestButton = button; button.setButtonText("Ask Codex to redraw").setCta()
			.onClick(() => { void run(""); }); })
		.addButton(button => { acceptButton = button; button.setButtonText("Accept redraw").onClick(() => {
			if (!figure.redrawSvg || figure.busy) return;
			figure.accepted = true;
			status.setText("Redraw accepted - it will be embedded on insert.");
			paint();
		}); })
		.addButton(button => { changesButton = button; button.setButtonText("Request changes").onClick(() => {
			const text = feedback.value.trim();
			if (!text) { status.setText("Describe the change first."); return; }
			void run(text);
		}); });
	const paint = (): void => {
		review.hidden = figure.choice !== "redraw" || !redraw;
		const has = Boolean(figure.redrawSvg);
		requestButton.setDisabled(figure.busy);
		requestButton.setButtonText(has ? "Redraw again from my drawing" : "Ask Codex to redraw");
		preview.hidden = !has;
		if (figure.redrawSvg) preview.src = svgDataUrl(figure.redrawSvg);
		acceptButton.setDisabled(figure.busy || !has || figure.accepted);
		changesButton.setDisabled(figure.busy || !has);
		feedback.hidden = !has;
		feedback.disabled = figure.busy;
	};
	paint();
}
