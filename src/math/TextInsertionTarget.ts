import type { MathEditor } from "./MathInsertionTarget";
import { mathContext } from "./Latex";

export function textInsertion(original: string, offset: number, value: string): string {
	if (mathContext(original, offset) !== "text") {
		throw new Error("Place the cursor outside math, code and note properties, or copy the recognized text.");
	}
	const text = value.replace(/\r\n?/g, "\n").trim();
	if (!text || text.length > 20_000) throw new Error("Review a shorter, nonempty text result before inserting.");
	const before = original.slice(0, offset), after = original.slice(offset);
	const prefix = before && !/[\s([{"']$/.test(before) ? " " : "";
	const suffix = after && !/^[\s.,!?;:)\]}"']/.test(after) ? " " : "";
	return prefix + text + suffix;
}

/** The note and cursor must still match after asynchronous OCR. */
export function captureTextTarget(active: MathEditor, current: () => MathEditor | null): (text: string) => void {
	const editor = active.editor, file = active.file;
	if (!editor || !file) throw new Error("Open a Markdown editor to insert recognized text.");
	const original = editor.getValue(), cursor = editor.getCursor(), offset = editor.posToOffset(cursor);
	let inserted = false;
	return value => {
		if (inserted) throw new Error("This text has already been inserted.");
		const now = current();
		if (now?.editor !== editor || now.file !== file || editor.getValue() !== original) {
			throw new Error("The destination note changed. Copy the result, or recognize the ink again.");
		}
		const text = textInsertion(original, offset, value);
		editor.replaceRange(text, cursor);
		inserted = true;
		editor.setCursor(editor.offsetToPos(offset + text.length));
	};
}
