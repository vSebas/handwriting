export type MathFormat = "display" | "inline";

/** Keep the expression portable; delimiters belong to the Markdown writer. */
export function normalizeLatex(value: string): string {
	let latex = value.replace(/\r\n?/g, "\n").trim();
	const fence = /^```(?:latex|tex|math)?\s*\n([\s\S]*?)\n```$/i.exec(latex);
	if (fence) latex = fence[1]!.trim();
	for (const [open, close] of [["$$", "$$"], ["\\[", "\\]"], ["\\(", "\\)"], ["$", "$"]] as const) {
		if (latex.startsWith(open) && latex.endsWith(close) && latex.length >= open.length + close.length) {
			latex = latex.slice(open.length, -close.length).trim();
			break;
		}
	}
	if (!latex) throw new Error("No math was recognized. Select one handwritten expression and try again.");
	if (latex.length > 20_000) throw new Error("The expression is too long. Select a smaller region.");
	if (/(^|[^\\])(?:\\\\)*\$/.test(latex) || /```/.test(latex)) {
		throw new Error("Use a single LaTeX expression without embedded Markdown math delimiters.");
	}
	if (/\\(?:documentclass|usepackage)\b|\\(?:begin|end)\s*\{document\}/.test(latex)) {
		throw new Error("Use a math expression, without a LaTeX document or package preamble.");
	}
	return latex;
}

export function mathMarkdown(value: string, format: MathFormat): string {
	const latex = normalizeLatex(value);
	if (format === "inline") {
		if (latex.includes("\n") || /(^|[^\\])(?:\\\\)*%/.test(latex)) {
			throw new Error("Use display math for multiline expressions or LaTeX comments.");
		}
		return `$${latex}$`;
	}
	return `$$\n${latex}\n$$`;
}

/** Find a complete dollar-delimited expression, ignoring escaped dollars and TeX comments. */
function mathEnd(text: string, start: number, marker: string): number {
	for (let i = start + marker.length; i < text.length; i++) {
		if (text[i] === "\\") { i++; continue; }
		if (marker === "$" && text[i] === "\n") return -1;
		if (text[i] === "%") {
			const newline = text.indexOf("\n", i);
			if (newline < 0 || marker === "$") return -1;
			i = newline;
			continue;
		}
		if (text.startsWith(marker, i)) {
			if (marker === "$" && (/\s/.test(text[i - 1] ?? "") || /[\d$]/.test(text[i + 1] ?? ""))) continue;
			return i;
		}
	}
	return -1;
}

/** Conservative cursor context: never insert math into frontmatter or code. */
export function mathContext(text: string, offset: number): "text" | "inline" | "display" | "code" {
	let fence = "";
	let ticks = 0;
	let yaml = false;
	for (let i = 0; i <= offset && i < text.length;) {
		if (i === 0 || text[i - 1] === "\n") {
			const line = text.slice(i, text.indexOf("\n", i) < 0 ? text.length : text.indexOf("\n", i));
			if (i === 0 && /^---\s*$/.test(line)) yaml = true;
			else if (yaml && /^(---|\.\.\.)\s*$/.test(line)) {
				if (offset <= i + line.length) return "code";
				yaml = false;
			}
			else if (!ticks && !yaml) {
				const match = /^\s*(?:>\s*)*(`{3,}|~{3,})/.exec(line);
				if (match) {
					const marker = match[1]!;
					if (!fence) fence = marker;
					else if (marker[0] === fence[0] && marker.length >= fence.length) fence = "";
					const end = i + line.length;
					if (end >= offset) return "code";
					i = end + 1;
					continue;
				}
				if (/^(?: {4}|\t)/.test(line) && offset <= i + line.length) return "code";
			}
		}
		if (i === offset) break;
		if (yaml || fence) { i++; continue; }
		if (text[i] === "\\" && !ticks) { i += 2; continue; }
		if (text[i] === "`") {
			let end = i + 1;
			while (text[end] === "`") end++;
			const count = end - i;
			if (!ticks) ticks = count;
			else if (ticks === count) ticks = 0;
			i = end;
			continue;
		}
		if (!ticks && text[i] === "$") {
			const marker = text[i + 1] === "$" ? "$$" : "$";
			const end = marker === "$" && /\s/.test(text[i + 1] ?? "") ? -1 : mathEnd(text, i, marker);
			if (end >= 0) {
				if (offset < i + marker.length || (offset > end && offset < end + marker.length)) return "code";
				if (offset <= end) {
					// Inserting at a comment or in the middle of a command changes the expression's meaning.
					const prefix = text.slice(i + marker.length, offset);
					if (/(^|[^\\])(?:\\\\)*%[^\n]*$/.test(prefix) || /\\[a-zA-Z]*$/.test(prefix) && /[a-zA-Z]/.test(text[offset] ?? "")) return "code";
					return marker === "$$" ? "display" : "inline";
				}
				i = end + marker.length;
				continue;
			}
		}
		i++;
	}
	return yaml || fence || ticks ? "code" : "text";
}

export function mathInsertion(text: string, offset: number, value: string, format: MathFormat): string {
	const context = mathContext(text, offset);
	if (context === "code") throw new Error("Place the cursor outside code, note properties, and math delimiters or commands; or copy the LaTeX instead.");
	if (context === "inline") {
		// Validate using the destination format, regardless of the dialog's output preference.
		mathMarkdown(value, "inline");
		return ` ${normalizeLatex(value)} `;
	}
	if (context === "display") return `\n${normalizeLatex(value)}\n`;
	const markdown = mathMarkdown(value, format);
	if (format === "inline") return markdown;
	const before = text.slice(0, offset);
	const after = text.slice(offset);
	const prefix = before.length === 0 || before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
	const suffix = after.startsWith("\n\n") ? "" : after.startsWith("\n") ? "\n" : "\n\n";
	return prefix + markdown + suffix;
}
