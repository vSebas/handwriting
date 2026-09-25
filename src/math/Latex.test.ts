import { describe, expect, it } from "vitest";
import { mathContext, mathInsertion, mathMarkdown, normalizeLatex } from "./Latex";

describe("portable LaTeX output", () => {
	it.each(["x^2", "$x^2$", "$$\nx^2\n$$", "\\(x^2\\)", "\\[x^2\\]", "```latex\nx^2\n```"])("normalizes %s", input => {
		expect(normalizeLatex(input)).toBe("x^2");
		expect(mathMarkdown(input, "inline")).toBe("$x^2$");
		expect(mathMarkdown(input, "display")).toBe("$$\nx^2\n$$");
	});
	it("keeps aligned environments, macros and escaped dollars intact", () => {
		const latex = String.raw`\begin{aligned}a&=\frac{1}{2}\\b&=\text{\$5}\end{aligned}`;
		expect(normalizeLatex(latex)).toBe(latex);
	});
	it.each(["", "$$ $$", "$x$ and $y$", "x $$ y", "\\documentclass{article}", "\\usepackage{amsmath}", "\\begin{document}x\\end{document}"])("refuses non-expression input %s", input => {
		expect(() => normalizeLatex(input)).toThrow();
	});
	it("does not let comments consume inline closing delimiters", () => {
		expect(() => mathMarkdown("x % comment", "inline")).toThrow("display");
		expect(() => mathMarkdown("x\ny", "inline")).toThrow("display");
		expect(mathMarkdown("x \\%", "inline")).toBe("$x \\%$");
		expect(mathMarkdown("x % comment", "display")).toBe("$$\nx % comment\n$$");
	});
});

describe("Markdown insertion", () => {
	it("separates display equations from surrounding paragraphs", () => {
		expect(mathInsertion("beforeafter", 6, "x", "display")).toBe("\n\n$$\nx\n$$\n\n");
		expect(mathInsertion("", 0, "x", "display")).toBe("$$\nx\n$$\n\n");
		expect(mathInsertion("a\n\nb", 3, "x", "display")).toBe("$$\nx\n$$\n\n");
	});
	it("uses only the body inside existing inline or display math", () => {
		expect(mathInsertion("$x+$", 3, "$$y$$", "display")).toBe(" y ");
		expect(mathInsertion("$$\nx+\n$$", 5, "y", "inline")).toBe("\ny\n");
		expect(mathInsertion("$x$ text", 8, "y", "inline")).toBe("$y$");
	});
	it("does not confuse currency with existing math", () => {
		const text = "Costs $5 or $10.";
		expect(mathContext(text, 8)).toBe("text");
	});
	it("rejects insertion on YAML boundaries, inside delimiters, or in a TeX comment", () => {
		for (const [text, at] of [["---\nx: y\n---", 0], ["---\nx: y\n---", 10], ["$$x$$", 1], ["$$x$$", 4], ["$$x % comment\n$$", 8], ["    code", 6]] as const) {
			expect(mathContext(text, at)).toBe("code");
		}
	});
	it("does not allow display-only content inside inline math or join control words", () => {
		expect(() => mathInsertion("$x+$", 3, "y % comment", "display")).toThrow("display");
		expect(mathInsertion("$\\alpha$", 7, "x", "inline")).toBe(" x ");
		expect(() => mathInsertion("$\\alpha$", 4, "x", "inline")).toThrow();
	});
	it.each(["---\ntitle: here", "```latex\nx", "~~~\nx", "`x", "``x", "> ```\nx"])("refuses insertion inside code/properties: %s", text => {
		expect(mathContext(text, text.length)).toBe("code");
		expect(() => mathInsertion(text, text.length, "y", "display")).toThrow("outside code");
	});
	it.each(["---\ntitle: '$x'\n---\n", "```latex\n$x\n```\n", "~~~\n$x\n~~~\n", "`$x` ", "\\$5 "])("ignores delimiters in code/properties/escapes: %s", text => {
		expect(mathContext(text, text.length)).toBe("text");
	});
});
