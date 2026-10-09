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

const IMAGE_EXTENSIONS = /\.(png|jpe?g|webp|gif|bmp)$/i;
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
	// Code fences, inline code, Obsidian comments and HTML comments do not
	// RENDER an embed, so a literal ![[private.png]] inside an example must
	// not quietly upload that file as context. An unterminated region strips
	// to the end of the slice - over-stripping context is the safe direction.
	const slice = markdown.slice(Math.max(0, from), to ?? markdown.length)
		.replace(/(`{3,}|~{3,})[\s\S]*?(\1|$)/g, "")
		.replace(/`[^`\n]*`/g, "")
		.replace(/%%[\s\S]*?(%%|$)/g, "")
		.replace(/<!--[\s\S]*?(-->|$)/g, "");
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

/** Resolve, decode and downscale each link to a PNG data URL the bridge
 * accepts. Failures skip the image, never the redraw. */
export async function loadNoteContextImages(app: App, from: TFile, links: string[], doc: Document = document): Promise<string[]> {
	const images: string[] = [];
	for (const link of links) {
		try {
			const target = app.metadataCache.getFirstLinkpathDest(link, from.path);
			if (!target || target.stat.size > MAX_SOURCE_BYTES) continue;
			const bytes = new Uint8Array(await app.vault.readBinary(target));
			const pixels = declaredImagePixels(bytes);
			if (pixels !== null && pixels > MAX_DECODE_PIXELS) continue;
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
