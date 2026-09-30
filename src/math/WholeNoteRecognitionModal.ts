import { App, Modal, Notice, Platform, Setting } from "obsidian";
import { noteInkImage, noteInkTiles, type InkImageBounds } from "./MathInkImage";
import { imageSelectionBounds } from "./WholeNoteInk";
import type { MathInk } from "./MathRecognition";

type Kind = "codex" | "text" | "math";
interface ReviewBlock { kind: Kind; value: string; card: HTMLElement; field: HTMLTextAreaElement }
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
	private selecting = false;
	private abort = new AbortController();
	private pending = false;
	private closed = false;

	constructor(app: App, private source: { ink: MathInk; bounds: InkImageBounds },
		private recognize: NoteImageRecognizer, private append: (markdown: string) => void) { super(app); }

	onOpen(): void {
		this.abort = new AbortController();
		this.closed = false;
		this.setTitle("Transcribe note handwriting");
		this.contentEl.addClass("handwriting-math-modal", "handwriting-whole-note-modal");
		this.contentEl.createEl("p", { text: "Select the whole handwriting image or draw an area. Codex reads mixed text and equations together; the local text and math models remain available for focused selections. Your existing note text, pasted images, and ink stay in place." });
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
					const preview = noteInkImage(this.source.ink, bounds);
					const images = this.kind === "codex" ? noteInkTiles(this.source.ink, bounds) : [preview];
					this.status.setText("Recognizing selected handwriting…");
					const kind = this.kind;
					const value = await this.recognize(images, kind, this.abort.signal, message => {
						if (!this.closed) this.status.setText(message);
					});
					if (this.closed) return;
					this.addBlock(kind, value, preview);
					this.status.setText("Review this reading. Select another area, or edit the Markdown below.");
				} catch (error) {
					if (!this.closed) this.status.setText(error instanceof Error ? error.message : "Recognition failed.");
				} finally {
					this.pending = false;
					if (!this.closed) button.setDisabled(false);
				}
			}));
		this.contentEl.createEl("p", { text: "Recognized selections (editable). Codex can read a mixed area in one request; use smaller areas if any symbols are unclear. Drawings remain as ink." });
		this.list = this.contentEl.createDiv({ cls: "handwriting-image-results" });
		this.contentEl.createEl("p", { text: "Markdown to append (editable)" });
		this.output = this.contentEl.createEl("textarea", { attr: { "aria-label": "Markdown transcription to append", rows: "10" } });
		new Setting(this.contentEl)
			.addButton(button => button.setButtonText("Append to this note").setCta().onClick(() => {
				if (this.pending) return;
				try {
					if (!this.output.value.trim()) throw new Error("Recognize a selection or enter Markdown first.");
					this.append(this.output.value);
					this.close();
					new Notice("Handwriting: transcription appended; original note content and ink kept.");
				} catch (error) { this.status.setText(error instanceof Error ? error.message : "Could not append transcription."); }
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

	private addBlock(kind: Kind, value: string, image: string): void {
		const card = this.list.createDiv({ cls: "handwriting-image-result" });
		card.createEl("img", { attr: { src: image, alt: "Recognized handwriting selection" } });
		const field = card.createEl("textarea", { attr: { "aria-label": kind === "math" ? "Recognized LaTeX" : kind === "codex" ? "Recognized Markdown" : "Recognized text", rows: "3" } });
		field.value = value;
		const block: ReviewBlock = { kind, value, card, field };
		this.blocks.push(block);
		field.addEventListener("input", () => { block.value = field.value; this.updateOutput(); });
		new Setting(card).setName(kind === "math" ? "Equation" : kind === "codex" ? "Mixed Markdown" : "Text")
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
		this.updateOutput();
	}

	private updateOutput(): void {
		this.output.value = this.blocks.flatMap(block => {
			const value = block.value.trim();
			return value ? [block.kind === "math" ? `$$\n${value}\n$$` : value] : [];
		}).join("\n\n");
	}

	onClose(): void {
		this.closed = true;
		this.abort.abort();
		this.contentEl.empty();
	}
}
