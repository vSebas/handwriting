import { App, Modal, Notice, Platform, Setting } from "obsidian";
import { noteInkImage, noteInkTiles } from "./MathInkImage";
import { imageSelectionBounds, noteInkSections, type NoteInkSource, type NotePlacement, type NoteStrokeSnapshot } from "./WholeNoteInk";

type Kind = "codex" | "text" | "math";
interface ReviewBlock { kind: Kind; value: string; card: HTMLElement; field: HTMLTextAreaElement; offset: number; strokes: NoteStrokeSnapshot[]; replaceInk: boolean }
export interface NoteCommit { blocks: Array<{ markdown: string; offset: number }>; placement: NotePlacement; combined: string; remove: NoteStrokeSnapshot[] }
export type NoteImageRecognizer = (images: string[], kind: Kind, signal: AbortSignal,
	progress: (message: string) => void) => Promise<string>;

/** The user selects visual crops; no stroke clustering can cut a word apart. */
export class WholeNoteRecognitionModal extends Modal {
	private blocks: ReviewBlock[] = [];
	private status!: HTMLElement;
	private output!: HTMLTextAreaElement;
	private list!: HTMLElement;
	private selectionEl!: HTMLElement;
	private preview!: HTMLImageElement;
	private selectedFrom: [number, number] = [0, 0];
	private selectedTo: [number, number] = [1, 1];
	private dragStart: [number, number] | null = null;
	private kind: Kind = "codex";
	private placement: NotePlacement = "sections";
	private selecting = false;
	private abort = new AbortController();
	private pending = false;
	private closed = false;

	constructor(app: App, private source: NoteInkSource,
		private recognize: NoteImageRecognizer, private commit: (result: NoteCommit) => void) { super(app); }

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
			.addDropdown(dropdown => dropdown.addOption("codex", "Mixed handwriting (Codex)")
				.addOption("text", "Text only (local)").addOption("math", "Equation only (local)")
				.onChange(value => { this.kind = value === "math" ? "math" : value === "text" ? "text" : "codex"; }))
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
					const kind = this.kind;
					for (const [index, section] of sections.entries()) {
						this.status.setText(`Recognizing section ${index + 1} of ${sections.length}…`);
						const preview = noteInkImage(section.ink, section.bounds);
						const images = kind === "codex" ? noteInkTiles(section.ink, section.bounds) : [preview];
						const value = await this.recognize(images, kind, this.abort.signal, message => {
							if (!this.closed) this.status.setText(`Section ${index + 1}: ${message}`);
						});
						if (this.closed) return;
						const complete = section.strokes.filter(stroke => stroke.bounds.left >= bounds.left && stroke.bounds.right <= bounds.right &&
							stroke.bounds.top >= bounds.top && stroke.bounds.bottom <= bounds.bottom);
						this.addBlock(kind, value, preview, section.anchor.offset, complete);
					}
					this.status.setText("Review each reading and its insertion section. Select another area if needed.");
				} catch (error) {
					if (!this.closed) this.status.setText(error instanceof Error ? error.message : "Recognition failed.");
				} finally {
					this.pending = false;
					if (!this.closed) button.setDisabled(false);
				}
			}));
		this.contentEl.createEl("p", { text: "Recognized sections (editable). Adjust each section's insertion point if needed. Only complete selected pen strokes can be replaced; other ink stays." });
		this.list = this.contentEl.createDiv({ cls: "handwriting-image-results" });
		new Setting(this.contentEl).setName("Insert transcription")
			.addDropdown(dropdown => dropdown.addOption("sections", "Beside matching note sections")
				.addOption("cursor", "At cursor when command opened")
				.addOption("end", "At end of note")
				.onChange(value => {
					this.placement = value === "cursor" ? "cursor" : value === "end" ? "end" : "sections";
					this.output.readOnly = this.placement === "sections";
					if (this.output.readOnly) this.updateOutput();
				}));
		this.contentEl.createEl("p", { text: "Combined Markdown. Edit each section above for matched placement; cursor and end placement also allow editing this combined copy." });
		this.output = this.contentEl.createEl("textarea", { attr: { "aria-label": "Combined Markdown transcription", rows: "10" } });
		this.output.readOnly = true;
		new Setting(this.contentEl)
			.addButton(button => button.setButtonText("Insert into this note").setCta().onClick(() => {
				if (this.pending) return;
				try {
					const blocks = this.blocks.flatMap(block => {
						const markdown = this.blockMarkdown(block);
						return markdown ? [{ markdown, offset: block.offset }] : [];
					});
					if (!this.output.value.trim() || !blocks.length) throw new Error("Recognize and review at least one section first.");
					const remove = [...new Map(this.blocks.flatMap(block => block.replaceInk && this.blockMarkdown(block)
						? block.strokes.map(stroke => [stroke.id, stroke] as const) : [])).values()];
					if (this.blocks.some(block => block.replaceInk) && !remove.length) throw new Error("No complete pen strokes are selected for replacement. Select a larger area.");
					this.commit({ blocks, placement: this.placement, combined: this.output.value, remove });
					this.close();
					new Notice(remove.length ? "Handwriting: transcription inserted; selected pen ink removed." : "Handwriting: transcription inserted; original ink kept.");
				} catch (error) { this.status.setText(error instanceof Error ? error.message : "Could not insert transcription."); }
			}))
			.addButton(button => button.setButtonText("Copy Markdown").onClick(async () => {
				if (this.pending) return;
				try {
					if (!this.output.value.trim()) throw new Error("Recognize a selection or enter Markdown first.");
					await this.contentEl.ownerDocument.defaultView!.navigator.clipboard.writeText(this.output.value);
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

	private addBlock(kind: Kind, value: string, image: string, offset: number, strokes: NoteStrokeSnapshot[]): void {
		const card = this.list.createDiv({ cls: "handwriting-image-result" });
		card.createEl("img", { attr: { src: image, alt: "Recognized handwriting selection" } });
		const field = card.createEl("textarea", { attr: { "aria-label": kind === "math" ? "Recognized LaTeX" : kind === "codex" ? "Recognized Markdown" : "Recognized text", rows: "3" } });
		field.value = value;
		const block: ReviewBlock = { kind, value, card, field, offset, strokes, replaceInk: false };
		this.blocks.push(block);
		field.addEventListener("input", () => { block.value = field.value; this.updateOutput(); });
		new Setting(card).setName(kind === "math" ? "Equation" : kind === "codex" ? "Mixed Markdown" : "Text")
			.addDropdown(dropdown => {
				for (const anchor of this.source.anchors) dropdown.addOption(String(anchor.offset), anchor.label);
				dropdown.setValue(String(offset)).onChange(value => { block.offset = Number(value); });
			})
			.addButton(button => button.setButtonText("Move up").onClick(() => {
				const index = this.blocks.indexOf(block);
				if (index < 1) return;
				this.blocks.splice(index, 1); this.blocks.splice(index - 1, 0, block);
				this.list.insertBefore(card, this.blocks[index]!.card);
				this.updateOutput();
			}))
			.addButton(button => button.setButtonText("Remove").onClick(() => {
				this.blocks.splice(this.blocks.indexOf(block), 1);
				card.remove(); this.updateOutput();
			}));
		new Setting(card).setName(`Replace this section's pen ink (${strokes.length} strokes)`)
			.setDesc("Only after insertion succeeds. Other ink, text, and images stay in the note.")
			.addToggle(toggle => toggle.setValue(false).setDisabled(strokes.length === 0)
				.onChange(value => { block.replaceInk = value; }));
		this.updateOutput();
	}

	private updateOutput(): void {
		this.output.value = this.blocks.map(block => this.blockMarkdown(block)).filter(Boolean).join("\n\n");
	}

	private blockMarkdown(block: ReviewBlock): string {
		const value = block.value.trim();
		return value ? block.kind === "math" ? `$$\n${value}\n$$` : value : "";
	}

	onClose(): void {
		this.closed = true;
		this.abort.abort();
		this.contentEl.empty();
	}
}
