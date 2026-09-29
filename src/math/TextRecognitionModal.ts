import { App, Modal, Notice, Setting } from "obsidian";
import type { MathInk } from "./MathRecognition";

export type TextRecognizer = (ink: MathInk, signal: AbortSignal, progress: (message: string) => void) => Promise<string>;

export class TextRecognitionModal extends Modal {
	private closed = false;
	private pending = false;
	private abort = new AbortController();
	private source!: HTMLTextAreaElement;
	private status!: HTMLElement;

	constructor(app: App, private ink: MathInk, private recognize: TextRecognizer, private insert?: (text: string) => void) {
		super(app);
	}

	onOpen(): void {
		this.closed = false;
		this.abort = new AbortController();
		this.setTitle("Handwriting to text");
		this.contentEl.addClass("handwriting-math-modal");
		this.contentEl.createEl("p", { text: `${this.ink.traces.length} selected pen strokes. This reads handwritten text lines on your laptop. Use the math command for equations; original ink is kept.` });
		new Setting(this.contentEl).addButton(button => button.setButtonText("Recognize text").setCta().onClick(async () => {
			if (this.closed || this.pending) return;
			this.pending = true;
			button.setDisabled(true);
			this.source.disabled = true;
			this.status.setText("Recognizing...");
			try {
				const text = await this.recognize(this.ink, this.abort.signal, message => {
					if (!this.closed) this.status.setText(message);
				});
				if (this.closed) return;
				this.source.value = text;
				this.status.setText("Review and edit the text before inserting or copying.");
			} catch (error) {
				if (!this.closed) this.status.setText(error instanceof Error ? error.message : "Text recognition failed.");
			} finally {
				this.pending = false;
				if (!this.closed) { button.setDisabled(false); this.source.disabled = false; }
			}
		}));
		this.status = this.contentEl.createEl("p", { attr: { role: "status", "aria-live": "polite" } });
		this.contentEl.createEl("p", { text: "Recognized text (editable)" });
		this.source = this.contentEl.createEl("textarea", { attr: { "aria-label": "Recognized text", rows: "8" } });
		const actions = new Setting(this.contentEl);
		if (this.insert) actions.addButton(button => button.setButtonText("Insert at saved cursor").setCta().onClick(() => {
			if (this.pending) return;
			try { this.insert!(this.source.value); this.close(); }
			catch (error) { this.status.setText(error instanceof Error ? error.message : "Could not insert text."); }
		}));
		actions.addButton(button => button.setButtonText("Copy text").onClick(async () => {
			if (this.pending || this.closed) return;
			try {
				await this.contentEl.ownerDocument.defaultView!.navigator.clipboard.writeText(this.source.value);
				if (!this.closed) new Notice("Handwriting: text copied");
			} catch (error) {
				if (!this.closed) this.status.setText(error instanceof Error ? error.message : "Could not copy text.");
			}
		}));
		if (!this.insert) this.contentEl.createEl("p", { text: "Copy the text into a note. PDF content itself is not converted." });
	}

	onClose(): void {
		this.closed = true;
		this.abort.abort();
		this.contentEl.empty();
	}
}
