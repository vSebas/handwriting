/** Browser seam: native DOM controls, with math rendering represented by its source. */
export class App {}
export class Notice { constructor(_text: string) {} }
export class Modal {
	contentEl = document.body.createDiv();
	constructor(_app: App) {}
	setTitle(title: string) { this.contentEl.setAttribute("aria-label", title); }
	open() { (this as unknown as { onOpen(): void }).onOpen(); }
	close() { (this as unknown as { onClose(): void }).onClose(); }
}
export class Setting {
	private el: HTMLElement;
	constructor(parent: HTMLElement) { this.el = parent.createDiv({ cls: "setting-item-control" }); }
	setName(name: string) { this.el.createSpan({ text: name }); return this; }
	addButton(setup: (button: object) => void) {
		const button = this.el.createEl("button");
		const api = {
			setButtonText(text: string) { button.textContent = text; return api; },
			setCta() { return api; },
			setDisabled(value: boolean) { button.disabled = value; return api; },
			onClick(fn: () => void) { button.addEventListener("click", fn); return api; },
		};
		setup(api); return this;
	}
	addDropdown(setup: (dropdown: object) => void) {
		const select = this.el.createEl("select");
		const api = {
			addOption(value: string, text: string) { select.add(new Option(text, value)); return api; },
			setValue(value: string) { select.value = value; return api; },
			onChange(fn: (value: string) => void) { select.addEventListener("change", () => fn(select.value)); return api; },
		};
		setup(api); return this;
	}
}
export function renderMath(latex: string): HTMLElement {
	const span = document.createElement("span");
	span.textContent = latex;
	span.style.whiteSpace = "nowrap";
	return span;
}
export async function finishRenderMath(): Promise<void> {}
