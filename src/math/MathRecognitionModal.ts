import { App, Modal, Notice, Setting, renderMath, finishRenderMath } from "obsidian";
import { mathMarkdown, normalizeLatex, type MathFormat } from "./Latex";
import type { MathInk } from "./MathRecognition";
import type { MathRecognizer } from "./MathRecognizer";

export class MathRecognitionModal extends Modal {
	private closed = false;
	private pending = false;
	private latex = "";
	private format: MathFormat = "display";
	private status!: HTMLElement;
	private source!: HTMLTextAreaElement;
	private preview!: HTMLElement;
	private candidatesEl!: HTMLElement;
	private candidateButtons: { button: HTMLButtonElement; latex: string }[] = [];
	private previewVersion = 0;
	private abort = new AbortController();

	constructor(app: App, private ink: MathInk, private recognizer: MathRecognizer, private insert?: (latex: string, format: MathFormat) => void) {
		super(app);
	}

	onOpen(): void {
		this.closed = false;
		this.abort = new AbortController();
		this.setTitle("Handwriting to LaTeX");
		this.contentEl.addClass("handwriting-math-modal");
		this.contentEl.createEl("p", { text: `${this.ink.traces.length} selected pen strokes. ${this.recognizer.description} Your original ink is kept.` });
		new Setting(this.contentEl).addButton(button => {
			button.setButtonText(`Recognize with ${this.recognizer.name}`).setCta().onClick(async () => {
				if (this.pending || this.closed) return;
				this.pending = true;
				button.setDisabled(true);
				this.source.disabled = true;
				for (const { button } of this.candidateButtons) button.disabled = true;
				this.status.setText("Recognizing…");
				try {
					const result = await this.recognizer.recognize(this.ink, this.abort.signal, message => {
						if (!this.closed) this.status.setText(message);
					});
					if (this.closed) return;
					this.latex = result.latex;
					this.source.value = result.latex;
					this.showCandidates(result.candidates ?? [result.latex]);
					this.status.setText(this.candidateButtons.length > 1
						? "Choose the closest reading, then review or edit it before inserting."
						: "Review the expression before inserting or copying.");
					this.updatePreview();
				} catch (error) {
					if (!this.closed) this.status.setText(error instanceof Error ? error.message : "Recognition failed.");
				} finally {
					this.pending = false;
					if (!this.closed) {
						button.setDisabled(false);
						this.source.disabled = false;
						for (const { button } of this.candidateButtons) button.disabled = false;
					}
				}
			});
		});
		this.status = this.contentEl.createEl("p", { attr: { role: "status", "aria-live": "polite" } });
		this.candidatesEl = this.contentEl.createDiv({ cls: "handwriting-math-candidates", attr: { role: "group", "aria-label": "Possible readings" } });
		this.contentEl.createEl("p", { text: "LaTeX (editable)" });
		this.source = this.contentEl.createEl("textarea", { attr: { "aria-label": "LaTeX expression", spellcheck: "false", rows: "5" } });
		this.source.addEventListener("input", () => {
			this.latex = this.source.value;
			this.updatePreview();
		});
		new Setting(this.contentEl).setName("Math format").addDropdown(dropdown => dropdown
			.addOption("display", "Display: $$…$$")
			.addOption("inline", "Inline: $…$")
			.setValue(this.format)
			.onChange(value => { this.format = value === "inline" ? "inline" : "display"; this.updatePreview(); }));
		this.preview = this.contentEl.createDiv({ cls: "handwriting-math-preview", attr: { "aria-label": "Math preview" } });
		const actions = new Setting(this.contentEl);
		if (this.insert) actions.addButton(button => button.setButtonText("Insert at saved cursor").setCta().onClick(() => {
			if (this.pending) return;
			try {
				this.insert!(normalizeLatex(this.latex), this.format);
				this.close();
			} catch (error) {
				this.status.setText(error instanceof Error ? error.message : "Could not insert math.");
			}
		}));
		actions.addButton(button => button.setButtonText("Copy Markdown").onClick(() => this.copy(false)));
		actions.addButton(button => button.setButtonText("Copy LaTeX").onClick(() => this.copy(true)));
		if (!this.insert) this.contentEl.createEl("p", { text: "Copy the result into a note or another math editor. PDF content itself is not converted." });
	}

	private showCandidates(candidates: string[]): void {
		this.candidatesEl.empty();
		this.candidateButtons = [];
		if (candidates.length < 2) return;
		this.candidatesEl.createEl("p", { text: "Possible readings — tap to select" });
		for (const [index, latex] of candidates.slice(0, 3).entries()) {
			const button = this.candidatesEl.createEl("button", { cls: "handwriting-math-candidate", attr: {
				type: "button", "aria-label": `Use candidate ${index + 1}: ${latex}`, "aria-pressed": "false",
			} });
			button.disabled = this.pending;
			button.createSpan({ cls: "handwriting-math-candidate-number", text: String(index + 1) });
			const expression = button.createSpan({ cls: "handwriting-math-candidate-expression" });
			try { expression.appendChild(renderMath(latex, false)); }
			catch { expression.setText(latex); }
			button.addEventListener("click", () => {
				if (this.pending || this.closed) return;
				this.latex = latex;
				this.source.value = latex;
				this.updatePreview();
			});
			this.candidateButtons.push({ button, latex });
		}
		void finishRenderMath().catch(() => { /* The editable LaTeX remains available. */ });
	}

	private async copy(raw: boolean): Promise<void> {
		if (this.pending || this.closed) return;
		try {
			const text = raw ? normalizeLatex(this.latex) : mathMarkdown(this.latex, this.format);
			await this.contentEl.ownerDocument.defaultView!.navigator.clipboard.writeText(text);
			if (!this.closed) new Notice(raw ? "Handwriting: LaTeX copied" : "Handwriting: math Markdown copied");
		} catch (error) {
			if (!this.closed) this.status.setText(error instanceof Error ? error.message : "Could not copy. Select and copy the LaTeX field manually.");
		}
	}

	private updatePreview(): void {
		for (const { button, latex } of this.candidateButtons) button.setAttribute("aria-pressed", String(latex === this.latex));
		const version = ++this.previewVersion;
		this.preview.empty();
		if (!this.latex.trim()) return;
		try {
			this.preview.appendChild(renderMath(normalizeLatex(this.latex), this.format === "display"));
			void finishRenderMath().catch(() => {
				if (!this.closed && version === this.previewVersion) this.preview.setText("Preview unavailable. Check the LaTeX expression.");
			});
		} catch (error) {
			this.preview.setText(error instanceof Error ? error.message : "Preview unavailable.");
		}
	}

	onClose(): void {
		this.abort.abort();
		this.closed = true;
		this.previewVersion++;
		this.contentEl.empty();
		this.candidateButtons = [];
	}
}
