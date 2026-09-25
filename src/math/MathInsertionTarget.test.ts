import { describe, expect, it } from "vitest";
import { EditorState, Transaction } from "@codemirror/state";
import { history, undo, undoDepth } from "@codemirror/commands";
import type { Editor, TFile } from "obsidian";
import { captureMathTarget, type MathEditor } from "./MathInsertionTarget";

function harness() {
	let state = EditorState.create({ doc: "before after", extensions: [history()] });
	const editor = {
		getValue: () => state.doc.toString(),
		getCursor: () => ({ line: 0, ch: 7 }),
		posToOffset: (pos: { line: number; ch: number }) => state.doc.line(pos.line + 1).from + pos.ch,
		offsetToPos: (offset: number) => { const line = state.doc.lineAt(offset); return { line: line.number - 1, ch: offset - line.from }; },
		replaceRange: (text: string, pos: { line: number; ch: number }) => {
			state = state.update({ changes: { from: editor.posToOffset(pos), insert: text } }).state;
		},
		setCursor: () => {}, focus: () => {},
	} as unknown as Editor;
	const original = { editor, file: {} as TFile };
	let active: MathEditor | null = original;
	return {
		editor, original, state: () => state,
		capture: () => captureMathTarget(original, () => active),
		switch: (value: MathEditor | null) => { active = value; },
		undo: () => undo({ state, dispatch: (tr: Transaction) => { state = tr.state; } }),
	};
}

describe("async math insertion destination", () => {
	it("inserts once at the captured cursor with a normal undo step", () => {
		const h = harness();
		const insert = h.capture();
		insert("x^2", "inline");
		expect(h.editor.getValue()).toBe("before $x^2$after");
		expect(undoDepth(h.state())).toBe(1);
		expect(() => insert("x^2", "inline")).toThrow("already");
		expect(h.undo()).toBe(true);
		expect(h.editor.getValue()).toBe("before after");
	});
	it("refuses a different note, editor, or closed destination", () => {
		for (const change of [null, { editor: {} as Editor, file: {} as TFile }]) {
			const h = harness();
			const insert = h.capture();
			h.switch(change);
			expect(() => insert("x", "display")).toThrow("changed");
			expect(h.editor.getValue()).toBe("before after");
		}
		const h = harness();
		const insert = h.capture();
		h.switch({ editor: h.editor, file: {} as TFile });
		expect(() => insert("x", "display")).toThrow("changed");
	});
	it("refuses a document modified during recognition without undoing the user's edit", () => {
		const h = harness();
		const insert = h.capture();
		h.editor.replaceRange("changed ", { line: 0, ch: 0 });
		expect(() => insert("x", "inline")).toThrow("changed");
		expect(h.editor.getValue()).toBe("changed before after");
	});
});
