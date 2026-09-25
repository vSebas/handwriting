import type { Editor, TFile } from "obsidian";
import { mathInsertion, type MathFormat } from "./Latex";

export interface MathEditor { editor?: Editor; file: TFile | null }

/** An async result must never land in a different note or at a stale offset. */
export function captureMathTarget(active: MathEditor, current: () => MathEditor | null): (latex: string, format: MathFormat) => void {
	const editor = active.editor;
	const file = active.file;
	if (!editor || !file) throw new Error("Open a Markdown editor to insert math.");
	const original = editor.getValue();
	const cursor = editor.getCursor();
	const offset = editor.posToOffset(cursor);
	let inserted = false;
	return (latex, format) => {
		const now = current();
		if (inserted) throw new Error("This expression has already been inserted.");
		if (now?.editor !== editor || now.file !== file || editor.getValue() !== original) {
			throw new Error("The destination note changed. Copy the result, or close this dialog and convert again.");
		}
		const text = mathInsertion(original, offset, latex, format);
		// A single public editor edit gives Obsidian and other editor plugins a normal undo step.
		editor.replaceRange(text, cursor);
		inserted = true;
		editor.setCursor(editor.offsetToPos(offset + text.length));
	};
}
