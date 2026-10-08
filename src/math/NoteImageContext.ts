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

/** Vault-image links embedded in markdown[from, to): wiki `![[target]]` and
 * Markdown `![](target)` forms, deduped in order, capped. External URLs are
 * not context this plugin fetches. */
export function embeddedImageLinks(markdown: string, from: number, to: number | null): string[] {
	const slice = markdown.slice(Math.max(0, from), to ?? markdown.length);
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
			const bitmap = await createImageBitmap(new Blob([await app.vault.readBinary(target)]));
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
