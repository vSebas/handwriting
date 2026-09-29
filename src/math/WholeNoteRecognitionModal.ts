import { App, Modal, Notice, Setting } from "obsidian";
import { mathInkImage } from "./MathInkImage";
import type { NoteInkRegion } from "./WholeNoteInk";

type Kind = "text" | "math" | "keep";
interface ReviewRegion { source: NoteInkRegion; kind: Kind; value: string; field: HTMLTextAreaElement; button: HTMLButtonElement }
export type NoteRecognizer = (region: NoteInkRegion, kind: "text" | "math", signal: AbortSignal,
	progress: (message: string) => void) => Promise<string>;

export class WholeNoteRecognitionModal extends Modal {
	private regions: ReviewRegion[] = [];
	private status!: HTMLElement;
	private output!: HTMLTextAreaElement;
	private abort = new AbortController();
	private pending = false;
	private closed = false;

	constructor(app: App, private sources: NoteInkRegion[], private recognize: NoteRecognizer,
		private append: (markdown: string) => void) { super(app); }

	onOpen(): void {
		this.abort = new AbortController();
		this.closed = false;
		this.setTitle("Transcribe note handwriting");
		this.contentEl.addClass("handwriting-math-modal", "handwriting-whole-note-modal");
		this.contentEl.createEl("p", { text: `${this.sources.length} ink regions in note order. Review each as text, math, or keep as ink. Existing note text and pasted images will stay exactly where they are.` });
		this.status = this.contentEl.createEl("p", { attr: { role: "status", "aria-live": "polite" } });
		new Setting(this.contentEl).addButton(button => button.setButtonText("Recognize all text/math regions").setCta().onClick(async () => {
			if (this.pending) return;
			this.pending = true;
			button.setDisabled(true);
			try {
				for (const [index, region] of this.regions.entries()) {
					if (this.closed) return;
					if (region.kind !== "keep" && !region.value.trim() && !await this.recognizeOne(region, index)) return;
				}
				this.status.setText("Recognition finished. Review every reading, then edit the Markdown before appending.");
			} finally {
				this.pending = false;
				if (!this.closed) button.setDisabled(false);
			}
		}));
		const list = this.contentEl.createDiv({ cls: "handwriting-whole-note-list" });
		for (const [index, source] of this.sources.entries()) {
			const card = list.createDiv({ cls: "handwriting-whole-note-region" });
			card.createEl("p", { text: `Region ${index + 1} · ${source.strokes} strokes` });
			card.createEl("img", { attr: { src: mathInkImage(source.ink), alt: `Original ink region ${index + 1}` } });
			const field = card.createEl("textarea", { attr: { "aria-label": `Recognized region ${index + 1}`, rows: "2" } });
			const review: ReviewRegion = { source, kind: "text", value: "", field, button: null! };
			this.regions.push(review);
			new Setting(card).setName("Interpret as").addDropdown(dropdown => dropdown
				.addOption("text", "Text")
				.addOption("math", "Math / LaTeX")
				.addOption("keep", "Drawing / keep as ink")
				.onChange(value => {
					review.kind = value as Kind;
					review.value = "";
					field.value = "";
					field.disabled = review.kind === "keep";
					review.button.disabled = review.kind === "keep";
					this.updateOutput();
				})).addButton(button => {
				button.setButtonText("Recognize region").onClick(async () => {
					if (this.pending || review.kind === "keep") return;
					this.pending = true;
					try { await this.recognizeOne(review, index); }
					finally { this.pending = false; }
				});
				review.button = button.buttonEl;
			});
			field.addEventListener("input", () => { review.value = field.value; this.updateOutput(); });
		}
		this.contentEl.createEl("p", { text: "Markdown to append (editable). Regions kept as ink are not inserted; their original ink remains on the note." });
		this.output = this.contentEl.createEl("textarea", { attr: { "aria-label": "Markdown transcription to append", rows: "10" } });
		new Setting(this.contentEl)
			.addButton(button => button.setButtonText("Append to this note").setCta().onClick(() => {
				if (this.pending) return;
				try {
					this.requireReviewed();
					this.append(this.output.value);
					this.close();
					new Notice("Handwriting: transcription appended; original note content and ink kept.");
				} catch (error) { this.status.setText(error instanceof Error ? error.message : "Could not append transcription."); }
			}))
			.addButton(button => button.setButtonText("Copy Markdown").onClick(async () => {
				if (this.pending) return;
				try {
					this.requireReviewed();
					await this.contentEl.ownerDocument.defaultView!.navigator.clipboard.writeText(this.output.value);
					new Notice("Handwriting: transcription copied");
				} catch (error) { this.status.setText(error instanceof Error ? error.message : "Could not copy transcription."); }
			}));
	}

	private async recognizeOne(region: ReviewRegion, index: number): Promise<boolean> {
		if (region.kind === "keep") return true;
		const kind = region.kind;
		this.status.setText(`Recognizing region ${index + 1} of ${this.regions.length}…`);
		try {
			const value = await this.recognize(region.source, kind, this.abort.signal, message => {
				if (!this.closed) this.status.setText(`Region ${index + 1}: ${message}`);
			});
			if (this.closed || region.kind !== kind) return false;
			region.field.value = value;
			region.value = value;
			this.updateOutput();
			return true;
		} catch (error) {
			if (!this.closed) this.status.setText(`Region ${index + 1}: ${error instanceof Error ? error.message : "Recognition failed."}`);
			return false;
		}
	}

	private updateOutput(): void {
		if (!this.output) return;
		this.output.value = this.regions.flatMap(region => {
			if (region.kind === "keep" || !region.value.trim()) return [];
			const value = region.value.trim();
			return [region.kind === "math" ? `$$\n${value}\n$$` : value];
		}).join("\n\n");
	}

	private requireReviewed(): void {
		const pending = this.regions.findIndex(region => region.kind !== "keep" && !region.value.trim());
		if (pending >= 0) throw new Error(`Review region ${pending + 1}: recognize it, type a correction, or mark it as drawing / keep as ink.`);
		if (!this.output.value.trim()) throw new Error("There is no transcription to append or copy.");
	}

	onClose(): void {
		this.closed = true;
		this.abort.abort();
		this.contentEl.empty();
	}
}
