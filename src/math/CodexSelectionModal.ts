import { App, Modal, Notice, Setting } from "obsidian";
import { noteInkImage, noteInkTiles } from "./MathInkImage";
import type { NoteInkSource } from "./WholeNoteInk";

export class CodexSelectionModal extends Modal {
	private closed = false;
	private pending = false;
	private abort = new AbortController();
	private output!: HTMLTextAreaElement;
	private status!: HTMLElement;
	private replaceInk = false;

	constructor(app: App, private source: NoteInkSource,
		private recognize: (images: string[], signal: AbortSignal, progress: (message: string) => void) => Promise<string>,
		private insert?: (markdown: string, replaceInk: boolean) => void) { super(app); }

	onOpen(): void {
		this.closed = false;
		this.abort = new AbortController();
		this.setTitle("Transcribe selected handwriting");
		this.contentEl.addClass("handwriting-math-modal");
		this.contentEl.createEl("p", { text: `${this.source.strokes.length} selected pen strokes. Codex reads mixed text, equations, and visual relationships. The original ink is kept.` });
		this.contentEl.createEl("img", { cls: "handwriting-selection-preview", attr: { src: noteInkImage(this.source.ink, this.source.bounds), alt: "Selected pen handwriting" } });
		new Setting(this.contentEl).addButton(button => button.setButtonText("Transcribe selection").setCta().onClick(async () => {
			if (this.closed || this.pending) return;
			this.pending = true;
			button.setDisabled(true);
			this.output.disabled = true;
			this.status.setText("Recognizing...");
			try {
				const images = noteInkTiles(this.source.ink, this.source.bounds);
				const markdown = await this.recognize(images, this.abort.signal, message => {
					if (!this.closed) this.status.setText(message);
				});
				if (this.closed) return;
				this.output.value = markdown;
				this.status.setText("Review and edit the Markdown before inserting or copying.");
			} catch (error) {
				if (!this.closed) this.status.setText(error instanceof Error ? error.message : "Transcription failed.");
			} finally {
				this.pending = false;
				if (!this.closed) { button.setDisabled(false); this.output.disabled = false; }
			}
		}));
		this.status = this.contentEl.createEl("p", { attr: { role: "status", "aria-live": "polite" } });
		this.output = this.contentEl.createEl("textarea", { attr: { "aria-label": "Recognized Markdown", rows: "8" } });
		if (this.insert) new Setting(this.contentEl).setName("Replace selected pen ink")
			.setDesc("Only the lassoed pen strokes are removed. Keep drawings outside the lasso to preserve them in place.")
			.addToggle(toggle => toggle.setValue(false).onChange(value => { this.replaceInk = value; }));
		const actions = new Setting(this.contentEl);
		if (this.insert) actions.addButton(button => button.setButtonText("Insert at saved cursor").setCta().onClick(() => {
			if (this.pending) return;
			try {
				if (!this.output.value.trim()) throw new Error("Transcribe and review the selection first.");
				this.insert!(this.output.value, this.replaceInk);
				this.close();
				new Notice(this.replaceInk ? "Handwriting: transcription inserted; selected pen ink removed." : "Handwriting: transcription inserted; original ink kept.");
			} catch (error) { this.status.setText(error instanceof Error ? error.message : "Could not insert transcription."); }
		}));
		actions.addButton(button => button.setButtonText("Copy Markdown").onClick(async () => {
			if (this.pending || this.closed) return;
			try {
				if (!this.output.value.trim()) throw new Error("Transcribe the selection first.");
				await this.contentEl.ownerDocument.defaultView!.navigator.clipboard.writeText(this.output.value);
				new Notice("Handwriting: Markdown copied");
			} catch (error) { this.status.setText(error instanceof Error ? error.message : "Could not copy transcription."); }
		}));
		if (!this.insert) this.contentEl.createEl("p", { text: "Copy the Markdown into a note. PDF ink is kept." });
	}

	onClose(): void {
		this.closed = true;
		this.abort.abort();
		this.contentEl.empty();
	}
}
