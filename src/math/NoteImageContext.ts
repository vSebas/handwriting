/**
 * Images already embedded in the note near a figure, as redraw context.
 *
 * When a drawing is a hand-copy of a pasted slide or screenshot, the
 * original is sitting right there in the note; sending it with the redraw
 * lets Codex see what the sketch was copied from. Everything here is
 * BEST-EFFORT context: a link that does not resolve, a format the platform
 * cannot decode, or an oversized file is skipped silently - a redraw must
 * never fail because its context could not be gathered.
 *
 * embeddedImageLinks is pure string work (node-testable); loadNoteContextImages
 * touches the vault and a canvas and is exercised by use, not the unit suite.
 */

import type { App, TFile } from "obsidian";
import { MAX_NOTE_CONTEXT_IMAGES, RENDER_MAX_EDGE_PX } from "./CodexLimits";

/** Only formats whose declared dimensions the header reveals BEFORE any
 * decode (see declaredImagePixels): a compressed bomb in a format we cannot
 * pre-measure would OOM the renderer, so WebP/BMP are simply not context. */
const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif)$/i;
/** Skip a source file larger than this; context is not worth a slow upload. */
const MAX_SOURCE_BYTES = 6 * 1024 * 1024;
/** Refuse to DECODE beyond this many pixels: a highly compressed 20k x 20k
 * PNG passes the byte cap but needs gigabytes as a bitmap, and an OOM kills
 * the renderer before any best-effort catch runs. ~120MB of RGBA survives. */
const MAX_DECODE_PIXELS = 30_000_000;

/** Declared pixel count read from the HEADER, before any decode: PNG IHDR
 * and JPEG SOF carry it. Other formats answer null; their decoded size is
 * bounded well enough by the byte cap (BMP is uncompressed outright). */
export function declaredImagePixels(bytes: Uint8Array): number | null {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (bytes.length > 24 && view.getUint32(0) === 0x89504e47) {
		return view.getUint32(16) * view.getUint32(20);
	}
	if (bytes.length > 10 && view.getUint32(0) === 0x47494638) {
		return view.getUint16(6, true) * view.getUint16(8, true);
	}
	if (bytes.length > 4 && view.getUint16(0) === 0xffd8) {
		let at = 2;
		while (at + 9 < bytes.length) {
			if (bytes[at] !== 0xff) { at++; continue; }
			const marker = bytes[at + 1]!;
			// SOF0-SOF15 carry dimensions, except DHT/JPG/DAC in that range.
			if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
				return view.getUint16(at + 5) * view.getUint16(at + 7);
			}
			at += 2 + view.getUint16(at + 2);
		}
	}
	return null;
}

/** The note range whose embedded images are a section's context. Anchors
 * mark where a block ENDS ("After: X"), so the image a sketch copies sits in
 * the block BEFORE the section's anchor: the range starts one anchor back
 * and runs to the next one (review finding, 2026-10-08). */
export function sectionContextRange(anchorOffsets: readonly number[], offset: number): { from: number; to: number | null } {
	const before = anchorOffsets.filter(candidate => candidate < offset);
	const after = anchorOffsets.filter(candidate => candidate > offset);
	return { from: before.length ? Math.max(...before) : 0, to: after.length ? Math.min(...after) : null };
}

/** Vault-image links embedded in markdown[from, to): wiki `![[target]]` and
 * Markdown `![](target)` forms, deduped in order, capped. External URLs are
 * not context this plugin fetches. */
export function embeddedImageLinks(markdown: string, from: number, to: number | null): string[] {
	const slice = visibleMarkdown(markdown.slice(Math.max(0, from), to ?? markdown.length));
	// Collected WITH positions: the nearest images should survive the cap,
	// not whichever syntax happened to be scanned first.
	const found: Array<{ at: number; link: string }> = [];
	for (const match of slice.matchAll(/!\[\[([^\][|#]+?)(?:[|#][^\]]*)?\]\]/g)) {
		found.push({ at: match.index, link: match[1]!.trim() });
	}
	for (const match of slice.matchAll(/!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
		let target = match[1]!;
		try { target = decodeURIComponent(target); } catch { /* keep the raw spelling */ }
		if (!/^[a-z][a-z0-9+.-]*:/i.test(target)) found.push({ at: match.index, link: target.trim() });
	}
	const seen = new Set<string>();
	return found.sort((a, b) => a.at - b.at).map(({ link }) => link).filter(link => {
		if (!IMAGE_EXTENSIONS.test(link) || seen.has(link)) return false;
		seen.add(link);
		return true;
	}).slice(0, MAX_NOTE_CONTEXT_IMAGES);
}

/**
 * Code and comments do not RENDER an embed, so a literal ![[private.png]]
 * inside an example must not quietly upload that file as context. Fences and
 * indented code go line by line, mirroring markdownBlockAnchors' fence rule,
 * because a regex treating an inline ~~~ span as a fence opener swallowed
 * every real embed after it (review finding, 2026-10-08). Stripped spans
 * leave a SPACE behind: deleting !<!-- x -->[[a.png]] outright would JOIN
 * the remains into an embed that was never in the note. Unterminated regions
 * strip to the end - over-stripping context is the safe direction.
 */
function visibleMarkdown(slice: string): string {
	const lines: string[] = [];
	let fence: string | null = null;
	// CRLF first: `.` and `$` treat a stray \r as a line terminator, so an
	// unnormalized Windows note never matched a fence opener at all and
	// every "hidden" embed leaked (review finding, 2026-10-08).
	for (const line of slice.replace(/\r\n?/g, "\n").split("\n")) {
		if (fence) {
			// A closer is the run alone (no info string), per CommonMark; a
			// looser rule closed early and LEAKED the rest of the block.
			const close = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)?.[1];
			if (close && close[0] === fence[0] && close.length >= fence.length) fence = null;
			continue;
		}
		const open = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
		// A backtick fence's info string may not contain a backtick, so a
		// one-line ```example``` is an inline CODE SPAN, not an open fence
		// that swallows every embed after it.
		if (open && !(open[1]![0] === "`" && open[2]!.includes("`"))) { fence = open[1]!; continue; }
		if (/^(?: {4}|\t)/.test(line)) continue;
		lines.push(line);
	}
	return stripCodeSpans(lines.join("\n"))
		.replace(/%%[\s\S]*?(%%|$)/g, " ")
		.replace(/<!--[\s\S]*?(-->|$)/g, " ");
}

/** Inline code spans, paired the CommonMark way: an opening backtick run
 * closes only with an EQUAL-length run. The lazy-regex form paired unequal
 * runs and left embeds between them unstripped. */
function stripCodeSpans(text: string): string {
	const runs = [...text.matchAll(/`+/g)];
	let out = "";
	let from = 0;
	let at = 0;
	while (at < runs.length) {
		const open = runs[at]!;
		const close = runs.findIndex((run, index) => index > at && run[0].length === open[0].length);
		if (close < 0) { at++; continue; }
		out += text.slice(from, open.index) + " ";
		from = runs[close]!.index + runs[close]![0].length;
		at = close + 1;
	}
	return out + text.slice(from);
}

/** Resolve, decode and downscale each link to a PNG data URL the bridge
 * accepts. Failures skip the image, never the redraw. */
export async function loadNoteContextImages(app: App, from: TFile, links: string[], doc: Document = document): Promise<string[]> {
	const images: string[] = [];
	for (const link of links) {
		try {
			const target = app.metadataCache.getFirstLinkpathDest(link, from.path);
			if (!target || target.stat.size > MAX_SOURCE_BYTES) continue;
			const bytes = new Uint8Array(await app.vault.readBinary(target));
			// The CONTENT must prove its size, not the filename: WebP bytes
			// under a .png name would otherwise reach the decoder unmeasured.
			const pixels = declaredImagePixels(bytes);
			if (pixels === null || pixels > MAX_DECODE_PIXELS) continue;
			const bitmap = await createImageBitmap(new Blob([bytes]));
			try {
				const scale = Math.min(1, RENDER_MAX_EDGE_PX / Math.max(bitmap.width, bitmap.height, 1));
				const canvas = doc.createElement("canvas");
				canvas.width = Math.max(1, Math.round(bitmap.width * scale));
				canvas.height = Math.max(1, Math.round(bitmap.height * scale));
				const context = canvas.getContext("2d");
				if (!context) continue;
				context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
				images.push(canvas.toDataURL("image/png"));
			} finally { bitmap.close(); }
		} catch { /* Undecodable or unreadable: context only, skip it. */ }
	}
	return images;
}
