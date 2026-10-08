import { App, Modal, Notice, Setting, type ButtonComponent } from "obsidian";
import { collectFigureEmbeds, renderFigureCard, reviewFiguresFor,
	type FigureEmbed, type FigureRedrawer, type ReviewFigure } from "./FigureReview";
import { noteInkImage, noteInkTiles } from "./MathInkImage";
import { stripFigureTokens, stripTokens } from "./NoteFigures";
import type { NoteImageRecognizer } from "./WholeNoteRecognitionModal";
import type { NoteInkSource, NoteStrokeSnapshot } from "./WholeNoteInk";

export class CodexSelectionModal extends Modal {
	private closed = false;
	private pending = false;
	private abort = new AbortController();
	private output!: HTMLTextAreaElement;
	private status!: HTMLElement;
	private figureList!: HTMLElement;
	private figures: ReviewFigure[] = [];
	private replaceInk = false;
	private figureSeq = 0;
	/** Scopes one transcription's figure redraws: transcribing again (or
	 * closing) cancels redraws of cards that no longer exist, so the laptop's
	 * single-flight slot is not held for a discarded figure. */
	private figureAbort = new AbortController();

	constructor(app: App, private source: NoteInkSource, private recognize: NoteImageRecognizer,
		private insert?: (markdown: string, remove: NoteStrokeSnapshot[], embeds: FigureEmbed[],
			anchorOffset: number | null) => void | Promise<void>,
		private redraw?: FigureRedrawer) { super(app); }

	onOpen(): void {
		this.closed = false;
		this.abort = new AbortController();
		this.figureAbort = new AbortController();
		this.setTitle("Transcribe selected handwriting");
		this.contentEl.addClass("handwriting-math-modal");
		this.contentEl.createEl("p", { text: `${this.source.strokes.length} selected pen strokes. Codex reads mixed text, equations, and visual relationships, and marks drawn figures for their own review. The original ink is kept unless you replace it.` });
		this.contentEl.createEl("img", { cls: "handwriting-selection-preview", attr: { src: noteInkImage(this.source.ink, this.source.bounds), alt: "Selected pen handwriting" } });
		new Setting(this.contentEl).addButton(button => button.setButtonText("Transcribe selection").setCta().onClick(async () => {
			if (this.closed || this.pending) return;
			this.pending = true;
			button.setDisabled(true);
			this.output.disabled = true;
			this.status.setText("Recognizing...");
			try {
				const images = noteInkTiles(this.source.ink, this.source.bounds);
				const result = await this.recognize(images, this.abort.signal, message => {
					if (!this.closed) this.status.setText(message);
				});
				if (this.closed) return;
				this.figures = [];
				this.figureList.empty();
				this.figureAbort.abort();
				this.figureAbort = new AbortController();
				if (this.insert) {
					const review = reviewFiguresFor(result.markdown, result.figures, this.source.bounds,
						this.source.strokes, () => `hw${++this.figureSeq}`);
					this.figures = review.figures;
					this.output.value = review.markdown;
					for (const figure of review.figures) renderFigureCard(this.figureList, figure, this.redraw, this.figureAbort.signal);
				} else {
					// The copy-only surface (PDF ink) writes no embed files, so
					// no figure token may reach the clipboard.
					this.output.value = stripFigureTokens(result.markdown);
				}
				this.status.setText(this.figures.length
					? "Review the Markdown and each detected figure before inserting."
					: "Review and edit the Markdown before inserting or copying.");
			} catch (error) {
				if (!this.closed) this.status.setText(error instanceof Error ? error.message : "Transcription failed.");
			} finally {
				this.pending = false;
				if (!this.closed) { button.setDisabled(false); this.output.disabled = false; }
			}
		}));
		this.status = this.contentEl.createEl("p", { attr: { role: "status", "aria-live": "polite" } });
		this.figureList = this.contentEl.createDiv({ cls: "handwriting-image-results" });
		this.output = this.contentEl.createEl("textarea", { attr: { "aria-label": "Recognized Markdown", rows: "8" } });
		let insertButton: ButtonComponent | null = null;
		if (this.insert) new Setting(this.contentEl).setName("Replace selected pen ink")
			.setDesc("Removes the lassoed pen strokes after inserting, and inserts beside the ink's own section instead of the saved cursor. A detected figure kept as pen ink is never removed.")
			.addToggle(toggle => toggle.setValue(false).onChange(value => {
				this.replaceInk = value;
				// Replaced ink must be succeeded IN PLACE by its transcription;
				// the button says where the text will actually go.
				insertButton?.setButtonText(value && this.insertionAnchor() !== null
					? "Insert beside the ink" : "Insert at saved cursor");
			}));
		const actions = new Setting(this.contentEl);
		if (this.insert) actions.addButton(button => { insertButton = button; button.setButtonText("Insert at saved cursor").setCta().onClick(async () => {
			if (this.pending) return;
			try {
				if (!this.output.value.trim()) throw new Error("Transcribe and review the selection first.");
				const collected = collectFigureEmbeds(this.figures, token => this.output.value.includes(token));
				const markdown = stripTokens(this.output.value, collected.strip);
				if (!markdown.trim()) throw new Error("Transcribe and review the selection first.");
				const remove = this.replaceInk ? this.source.strokes.filter(stroke => !collected.keepInkIds.has(stroke.id)) : [];
				// AWAITED: a failed insert must land back in this status line
				// with the review intact, not close the dialog as a success.
				this.pending = true;
				try { await this.insert!(markdown, remove, collected.embeds, this.replaceInk ? this.insertionAnchor() : null); }
				finally { this.pending = false; }
				if (this.closed) return;
				this.close();
				new Notice(remove.length ? "Handwriting: transcription inserted; selected pen ink removed." : "Handwriting: transcription inserted; original ink kept.");
			} catch (error) { if (!this.closed) this.status.setText(error instanceof Error ? error.message : "Could not insert transcription."); }
		}); });
		actions.addButton(button => button.setButtonText("Copy Markdown").onClick(async () => {
			if (this.pending || this.closed) return;
			try {
				if (!this.output.value.trim()) throw new Error("Transcribe the selection first.");
				// No embed file exists on the copy path, so no token may leave with the text.
				await this.contentEl.ownerDocument.defaultView!.navigator.clipboard.writeText(stripFigureTokens(this.output.value));
				new Notice("Handwriting: Markdown copied");
			} catch (error) { this.status.setText(error instanceof Error ? error.message : "Could not copy transcription."); }
		}));
		if (!this.insert) this.contentEl.createEl("p", { text: "Copy the Markdown into a note. PDF ink is kept." });
	}

	/** The last anchor above the lassoed ink: the same "beside its section"
	 * rule the whole-note flow uses. Null (no anchors) falls back to cursor. */
	private insertionAnchor(): number | null {
		if (!this.source.anchors.length) return null;
		const above = [...this.source.anchors].reverse().find(anchor => anchor.y <= this.source.bounds.top);
		return (above ?? this.source.anchors[0]!).offset;
	}

	onClose(): void {
		this.closed = true;
		this.abort.abort();
		this.figureAbort.abort();
		this.contentEl.empty();
	}
}
