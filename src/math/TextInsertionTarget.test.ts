import { describe, expect, it } from "vitest";
import type { Editor, TFile } from "obsidian";
import { captureTextTarget, textInsertion } from "./TextInsertionTarget";

describe("handwritten text insertion", () => {
	it("adds readable spacing at a saved text cursor", () => {
		expect(textInsertion("beforeafter", 6, "hello\r\nworld")).toBe(" hello\nworld ");
		expect(textInsertion("", 0, "hello")).toBe("hello");
	});
	it("does not place prose inside code, math, or note properties", () => {
		expect(() => textInsertion("$x$", 2, "hello")).toThrow("outside math");
		expect(() => textInsertion("---\ntitle: note\n---\n", 5, "hello")).toThrow("outside math");
		expect(() => textInsertion("", 0, "  ")).toThrow("nonempty");
	});
	it("refuses to insert into a note changed while OCR was running", () => {
		let value = "before after";
		const editor = { getValue: () => value, getCursor: () => ({ line: 0, ch: 7 }), posToOffset: () => 7,
			replaceRange: (text: string) => { value = value.slice(0, 7) + text + value.slice(7); },
			offsetToPos: () => ({ line: 0, ch: 7 }), setCursor: () => {} } as unknown as Editor;
		const active = { editor, file: {} as TFile };
		const insert = captureTextTarget(active, () => active);
		value = "edited before after";
		expect(() => insert("recognized")).toThrow("changed");
		expect(value).toBe("edited before after");
	});
});
