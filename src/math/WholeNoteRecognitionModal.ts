import { App, Modal, Notice, Platform, Setting } from "obsidian";
import { collectFigureEmbeds, renderFigureCard, reviewFiguresFor,
	type FigureEmbed, type FigureRedrawer, type ReviewFigure } from "./FigureReview";
import { noteInkImage, noteInkTiles } from "./MathInkImage";
import { stripFigureTokens, stripTokens, type DetectedFigure } from "./NoteFigures";
import { sectionContextRange } from "./NoteImageContext";
import { imageSelectionBounds, noteInkSections, type NoteInkSource, type NotePlacement, type NoteStrokeSnapshot } from "./WholeNoteInk";

interface ReviewBlock {
	value: string; card: HTMLElement; field: HTMLTextAreaElement;
	offset: number; suggestedOffset: number; placementSelect: HTMLSelectElement | null;
	strokes: NoteStrokeSnapshot[]; replaceInk: boolean; figures: ReviewFigure[];
	/** Scopes the block's figure redraws: removing the section cancels them
	 * (and /cancel frees the laptop) instead of leaving Codex drawing for a
	 * card that no longer exists. */
	abort: AbortController;
}
export interface NoteCommit {
	blocks: Array<{ markdown: string; offset: number }>; placement: NotePlacement; combined: string;
	remove: NoteStrokeSnapshot[]; embeds: FigureEmbed[];
}
export type NoteImageRecognizer = (images: string[], signal: AbortSignal,
	progress: (message: string) => void) => Promise<{ markdown: string; figures: DetectedFigure[] }>;

/** The user selects visual crops; no stroke clustering can cut a word apart. */
export class WholeNoteRecognitionModal extends Modal {
	private blocks: ReviewBlock[] = [];
	private status!: HTMLElement;
	private output!: HTMLTextAreaElement;
	private list!: HTMLElement;
	private selectionEl!: HTMLElement;
	private preview!: HTMLImageElement;
	private placementSelect!: HTMLSelectElement;
	private selectedFrom: [number, number] = [0, 0];
	private selectedTo: [number, number] = [1, 1];
	private dragStart: [number, number] | null = null;
	private placement: NotePlacement = "sections";
	private selecting = false;
	private abort = new AbortController();
	private pending = false;
	private closed = false;
	/** Two sections may both declare "figure 1"; this makes tokens unique. */
	private figureSeq = 0;

	constructor(app: App, private source: NoteInkSource, private recognize: NoteImageRecognizer,
		private commit: (result: NoteCommit) => void | Promise<void>, private redraw?: FigureRedrawer,
		private noteImages?: (from: number, to: number | null) => Promise<string[]>) { super(app); }

	onOpen(): void {
		this.abort = new AbortController();
		this.closed = false;
		this.setTitle("Transcribe note handwriting");
		this.contentEl.addClass("handwriting-math-modal", "handwriting-whole-note-modal");
		this.contentEl.createEl("p", { text: "Select the whole ink image or draw an area. Recognition separates handwriting only where rendered note text or images divide it. Review each section before inserting." });
		this.status = this.contentEl.createEl("p", { attr: { role: "status", "aria-live": "polite" } });
		const scroll = this.contentEl.createDiv({ cls: "handwriting-image-scroll" });
		const selector = scroll.createDiv({ cls: "handwriting-image-selector" });
		this.selecting = !Platform.isMobile;
		if (this.selecting) selector.addClass("is-selecting");
		this.preview = selector.createEl("img", { attr: { src: noteInkImage(this.source.ink, this.source.bounds), alt: "All pen handwriting in this note" } });
		this.preview.draggable = false;
		this.selectionEl = selector.createDiv({ cls: "handwriting-image-selection" });
		this.paintSelection();
		const fraction = (event: PointerEvent): [number, number] => {
			const box = this.preview.getBoundingClientRect();
			return [Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)),
				Math.max(0, Math.min(1, (event.clientY - box.top) / box.height))];
		};
		selector.addEventListener("pointerdown", event => {
			if (event.button !== 0 || this.pending || !this.selecting) return;
			event.preventDefault();
			this.dragStart = fraction(event);
			this.selectedFrom = this.dragStart;
			this.selectedTo = this.dragStart;
			selector.setPointerCapture(event.pointerId);
			this.paintSelection();
		});
		selector.addEventListener("pointermove", event => {
			if (!this.dragStart) return;
			this.selectedTo = fraction(event);
			this.paintSelection();
		});
		let selectionButton: HTMLButtonElement | null = null;
		const finish = (event: PointerEvent) => {
			if (!this.dragStart) return;
			this.selectedTo = fraction(event);
			this.dragStart = null;
			if (selector.hasPointerCapture(event.pointerId)) selector.releasePointerCapture(event.pointerId);
			if (Math.abs(this.selectedTo[0] - this.selectedFrom[0]) < .01 ||
				Math.abs(this.selectedTo[1] - this.selectedFrom[1]) < .01) {
				this.selectedFrom = [0, 0]; this.selectedTo = [1, 1];
			}
			this.paintSelection();
			if (Platform.isMobile) {
				this.selecting = false;
				selector.removeClass("is-selecting");
				if (selectionButton) selectionButton.setText("Select area");
			}
		};
		selector.addEventListener("pointerup", finish);
		selector.addEventListener("pointercancel", finish);
		new Setting(this.contentEl)
			.addButton(button => {
				button.setButtonText(this.selecting ? "Scroll image" : "Select area").onClick(() => {
					this.selecting = !this.selecting;
					if (this.selecting) selector.addClass("is-selecting"); else selector.removeClass("is-selecting");
					button.setButtonText(this.selecting ? "Scroll image" : "Select area");
				});
				selectionButton = button.buttonEl;
			})
			.addButton(button => button.setButtonText("Select whole image").onClick(() => {
				this.selectedFrom = [0, 0]; this.selectedTo = [1, 1]; this.paintSelection();
			}))
			.addButton(button => button.setButtonText("Recognize selection").setCta().onClick(async () => {
				if (this.pending || this.closed) return;
				this.pending = true;
				button.setDisabled(true);
				try {
					const bounds = imageSelectionBounds(this.source.bounds, this.selectedFrom, this.selectedTo);
					const sections = noteInkSections(this.source, bounds);
					if (sections.length > 12) throw new Error("This selection crosses more than twelve handwriting sections. Select a smaller part of the note.");
					for (const [index, section] of sections.entries()) {
						this.status.setText(`Recognizing section ${index + 1} of ${sections.length}…`);
						const preview = noteInkImage(section.ink, section.bounds);
						const images = noteInkTiles(section.ink, section.bounds);
						const result = await this.recognize(images, this.abort.signal, message => {
							if (!this.closed) this.status.setText(`Section ${index + 1}: ${message}`);
						});
						if (this.closed) return;
						const review = reviewFiguresFor(result.markdown, result.figures, section.bounds,
							section.strokes, () => `hw${++this.figureSeq}`);
						const complete = section.strokes.filter(stroke => stroke.bounds.left >= bounds.left && stroke.bounds.right <= bounds.right &&
							stroke.bounds.top >= bounds.top && stroke.bounds.bottom <= bounds.bottom);
						this.addBlock(review.markdown, preview, section.anchor.offset, complete, review.figures);
					}
					this.status.setText("Review each reading and its insertion section. Select another area if needed.");
				} catch (error) {
					if (!this.closed) this.status.setText(error instanceof Error ? error.message : "Recognition failed.");
				} finally {
					this.pending = false;
					if (!this.closed) button.setDisabled(false);
				}
			}));
		this.contentEl.createEl("p", { text: "Recognized sections (editable). Adjust a section's insertion point while keeping its ink. Replacing its ink uses the suggested matching section automatically." });
		this.list = this.contentEl.createDiv({ cls: "handwriting-image-results" });
		new Setting(this.contentEl).setName("Insert transcription")
			.addDropdown(dropdown => {
				dropdown.addOption("sections", "Beside matching note sections")
				.addOption("cursor", "At cursor when command opened")
				.addOption("end", "At end of note")
				.onChange(value => {
					this.placement = value === "cursor" ? "cursor" : value === "end" ? "end" : "sections";
					this.output.readOnly = this.placement === "sections";
					if (this.output.readOnly) this.updateOutput();
				});
				this.placementSelect = dropdown.selectEl;
			});
		this.contentEl.createEl("p", { text: "Combined Markdown. Edit each section above for matched placement; cursor and end placement also allow editing this combined copy." });
		this.output = this.contentEl.createEl("textarea", { attr: { "aria-label": "Combined Markdown transcription", rows: "10" } });
		this.output.readOnly = true;
		new Setting(this.contentEl)
			.addButton(button => button.setButtonText("Insert into this note").setCta().onClick(async () => {
				if (this.pending) return;
				try {
					// Token presence is judged against the text that actually
					// inserts: per-section Markdown for matched placement, the
					// editable combined copy for cursor/end.
					const present = (token: string) => this.placement === "sections"
						? this.blocks.some(block => this.blockMarkdown(block).includes(token))
						: this.output.value.includes(token);
					const embeds: FigureEmbed[] = [];
					const keepInk = new Set<string>();
					const strip: string[] = [];
					for (const block of this.blocks) {
						const collected = collectFigureEmbeds(block.figures, present);
						embeds.push(...collected.embeds);
						for (const id of collected.keepInkIds) keepInk.add(id);
						strip.push(...collected.strip);
					}
					const blocks = this.blocks.flatMap(block => {
						const markdown = stripTokens(this.blockMarkdown(block), strip);
						return markdown ? [{ markdown, offset: block.offset }] : [];
					});
					const combined = stripTokens(this.output.value, strip);
					if (!combined.trim() || !blocks.length) throw new Error("Recognize and review at least one section first.");
					const remove = [...new Map(this.blocks.flatMap(block => block.replaceInk && this.blockMarkdown(block)
						? block.strokes.filter(stroke => !keepInk.has(stroke.id)).map(stroke => [stroke.id, stroke] as const) : [])).values()];
					if (this.blocks.some(block => block.replaceInk) && !remove.length && !keepInk.size) throw new Error("No complete pen strokes are selected for replacement. Select a larger area.");
					if (remove.length && this.placement !== "sections") throw new Error("Replacing ink inserts beside its original section.");
					// AWAITED: a failed insert (the note changed, an embed write
					// refused) must land back in this status line with the
					// reviewed state intact, not close the dialog over a note
					// that never received the text. INERT while it runs: the
					// blocks and removal list are already captured, so an edit
					// or section removal during the await would commit state
					// the dialog no longer shows.
					this.pending = true;
					this.contentEl.inert = true;
					try { await this.commit({ blocks, placement: this.placement, combined, remove, embeds }); }
					finally { this.pending = false; this.contentEl.inert = false; }
					if (this.closed) return;
					this.close();
					new Notice(remove.length ? "Handwriting: transcription inserted; selected pen ink removed." : "Handwriting: transcription inserted; original ink kept.");
				} catch (error) { if (!this.closed) this.status.setText(error instanceof Error ? error.message : "Could not insert transcription."); }
			}))
			.addButton(button => button.setButtonText("Copy Markdown").onClick(async () => {
				if (this.pending) return;
				try {
					if (!this.output.value.trim()) throw new Error("Recognize a selection or enter Markdown first.");
					// No embed file exists on the copy path, so no token may leave with the text.
					await this.contentEl.ownerDocument.defaultView!.navigator.clipboard.writeText(stripFigureTokens(this.output.value));
					new Notice("Handwriting: transcription copied");
				} catch (error) { this.status.setText(error instanceof Error ? error.message : "Could not copy transcription."); }
			}));
	}

	private paintSelection(): void {
		const [x1, y1] = this.selectedFrom, [x2, y2] = this.selectedTo;
		this.selectionEl.style.left = `${Math.min(x1, x2) * 100}%`;
		this.selectionEl.style.top = `${Math.min(y1, y2) * 100}%`;
		this.selectionEl.style.width = `${Math.abs(x2 - x1) * 100}%`;
		this.selectionEl.style.height = `${Math.abs(y2 - y1) * 100}%`;
	}

	private addBlock(value: string, image: string, offset: number, strokes: NoteStrokeSnapshot[],
		figures: ReviewFigure[]): void {
		const card = this.list.createDiv({ cls: "handwriting-image-result" });
		card.createEl("img", { attr: { src: image, alt: "Recognized handwriting selection" } });
		const field = card.createEl("textarea", { attr: { "aria-label": "Recognized Markdown", rows: "3" } });
		field.value = value;
		const block: ReviewBlock = { value, card, field, offset, suggestedOffset: offset,
			placementSelect: null, strokes, replaceInk: false, figures, abort: new AbortController() };
		this.blocks.push(block);
		// Context is read at REDRAW time, so edits to the reviewed Markdown
		// ride along: the section's text, its ink overview, and any images
		// already placed around the section in the note.
		const context = async () => {
			const range = this.contextRange(block.offset);
			return {
				text: stripFigureTokens(this.blockMarkdown(block)),
				images: [image, ...(this.noteImages ? await this.noteImages(range.from, range.to) : [])],
			};
		};
		for (const figure of figures) renderFigureCard(card, figure, this.redraw, block.abort.signal, context);
		field.addEventListener("input", () => { block.value = field.value; this.updateOutput(); });
		new Setting(card).setName("Mixed Markdown")
			.addDropdown(dropdown => {
				for (const anchor of this.source.anchors) dropdown.addOption(String(anchor.offset), anchor.label);
				dropdown.setValue(String(offset)).onChange(value => { block.offset = Number(value); });
				block.placementSelect = dropdown.selectEl;
			})
			.addButton(button => button.setButtonText("Move up").onClick(() => {
				const index = this.blocks.indexOf(block);
				if (index < 1) return;
				this.blocks.splice(index, 1); this.blocks.splice(index - 1, 0, block);
				this.list.insertBefore(card, this.blocks[index]!.card);
				this.updateOutput();
			}))
			.addButton(button => button.setButtonText("Remove").onClick(() => {
				block.abort.abort();
				this.blocks.splice(this.blocks.indexOf(block), 1);
				card.remove(); this.updateOutput(); this.syncReplacementPlacement();
			}));
		new Setting(card).setName(`Replace this section's pen ink (${strokes.length} strokes)`)
			.setDesc("Removes this section's pen strokes after inserting. A detected figure follows its own choice above: kept as pen ink it is never removed; embedded as an image its ink is replaced by the embed. Other text and pasted images stay in the note.")
			.addToggle(toggle => toggle.setValue(false).setDisabled(strokes.length === 0)
				.onChange(value => {
					block.replaceInk = value;
					if (value) {
						block.offset = block.suggestedOffset;
						if (block.placementSelect) block.placementSelect.value = String(block.suggestedOffset);
					}
					if (block.placementSelect) block.placementSelect.disabled = value;
					this.syncReplacementPlacement();
				}));
		this.updateOutput();
	}

	private contextRange(offset: number): { from: number; to: number | null } {
		return sectionContextRange(this.source.anchors.map(anchor => anchor.offset), offset);
	}

	private syncReplacementPlacement(): void {
		const replacing = this.blocks.some(block => block.replaceInk);
		if (replacing) {
			this.placement = "sections";
			this.placementSelect.value = "sections";
			this.output.readOnly = true;
			this.updateOutput();
		}
		this.placementSelect.disabled = replacing;
	}

	private updateOutput(): void {
		this.output.value = this.blocks.map(block => this.blockMarkdown(block)).filter(Boolean).join("\n\n");
	}

	private blockMarkdown(block: ReviewBlock): string {
		const value = block.value.trim();
		return value;
	}

	onClose(): void {
		this.closed = true;
		this.abort.abort();
		for (const block of this.blocks) block.abort.abort();
		this.contentEl.empty();
	}
}
