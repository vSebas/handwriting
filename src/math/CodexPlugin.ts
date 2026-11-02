/**
 * The plugin's half of Codex transcription (the fork's feature): the laptop
 * bridge's lifecycle, the figure-redraw loop both review dialogs use, the
 * note-image context loader, and the one commit path that writes figure
 * embeds and inserts a reviewed transcription. Methods of HandwritingPlugin,
 * installed on its prototype when main.ts loads, like the other slices. The
 * instance state they keep (`codexService`, the two open dialogs) is lazy and
 * nullable, so an `Object.create` instance in a test needs no initialiser.
 */
import { Platform, type TFile } from "obsidian";
import { installMethods } from "../inline/InstallMethods";
import { stripMarkdownExtension } from "../util/MarkdownPath";
import { LocalCodexService } from "./CodexDesktop";
import { UNPINNED_MODEL_LABEL } from "./CodexLimits";
import { redrawFigureImage } from "./CodexService";
import type { CodexSelectionModal } from "./CodexSelectionModal";
import type { FigureEmbed, FigureRedrawer } from "./FigureReview";
import { sanitizeFigureSvg } from "./NoteFigures";
import { embeddedImageLinks, loadNoteContextImages } from "./NoteImageContext";
import type { NotePlacement, NoteStrokeSnapshot, TranscriptionBlock } from "./WholeNoteInk";
import type { WholeNoteRecognitionModal } from "./WholeNoteRecognitionModal";
import type { HandwritingPlugin } from "../main";

/** The overlay seam insertTranscription needs, as InkOverlayTranscription.ts installs it. */
export interface TranscribedInkHost {
	validateTranscribedInk(path: string, expected: readonly Pick<NoteStrokeSnapshot, "id" | "signature">[]): void;
	removeTranscribedInk(path: string, expected: readonly Pick<NoteStrokeSnapshot, "id" | "signature">[]): number;
}

declare module "../main" {
	interface HandwritingPlugin {
		wholeNoteModal?: WholeNoteRecognitionModal | null;
		selectionModal?: CodexSelectionModal | null;
		codexService?: LocalCodexService | null;
		getLocalCodexService(): LocalCodexService;
		localCodexModelSelection(): { model: string; source: string };
		signInToCodex(): Promise<void>;
		startLocalCodexService(): Promise<void>;
		startLocalCodexServiceQuietly(): void;
		stopLocalCodexService(): void;
		figureRedrawer(): FigureRedrawer;
		noteImageLoader(markdown: string, file: TFile): (from: number, to: number | null) => Promise<string[]>;
		insertTranscription(overlay: TranscribedInkHost, file: TFile,
			insert: (blocks: TranscriptionBlock[], placement: NotePlacement, combined: string) => void,
			blocks: TranscriptionBlock[], placement: NotePlacement, combined: string,
			remove: NoteStrokeSnapshot[], embeds: FigureEmbed[]): Promise<void>;
	}
}

	function getLocalCodexService(this: HandwritingPlugin): LocalCodexService {
		return this.codexService ??= new LocalCodexService(() => ({
			url: this.settings.codexServiceUrl, token: this.settings.codexServiceToken, model: this.settings.codexModel,
		}));
	}

	function localCodexModelSelection(this: HandwritingPlugin): { model: string; source: string } {
		// The service keeps the unpinned state as `model: null`; the settings
		// UI wants the human label, so the mapping lives at this edge.
		const selection = this.getLocalCodexService().modelSelection();
		return { ...selection, model: selection.model ?? UNPINNED_MODEL_LABEL };
	}

	async function signInToCodex(this: HandwritingPlugin): Promise<void> {
		if (!Platform.isDesktopApp) throw new Error("Sign in on the laptop running desktop Obsidian.");
		await this.getLocalCodexService().signIn();
		await this.startLocalCodexService();
	}

	async function startLocalCodexService(this: HandwritingPlugin): Promise<void> {
		if (!Platform.isDesktopApp) return;
		// The gates live HERE, not only at the call sites: a transcription
		// modal left open across the settings toggle would otherwise restart
		// the LAN-listening bridge from its recognize callback while the
		// setting reads off (review finding, 2026-10-01), and an awaited
		// context load resuming after onunload would start a fresh listener
		// on an instance nothing will ever stop (review finding, 2026-10-08).
		if (this.unloaded) throw new Error("Handwriting is unloading.");
		if (!this.settings.codexEnabled) throw new Error("Turn on Transcribe handwriting with Codex in Handwriting settings first.");
		const token = await this.getLocalCodexService().start();
		if (this.unloaded) return;
		if (this.settings.codexServiceToken !== token) {
			this.settings.codexServiceToken = token;
			await this.persistSettings();
		}
	}

	/** The startup/toggle-on form: failures surface at the points of use
	 * (the modals, Test connection, Sign in), so here they only log. */
	function startLocalCodexServiceQuietly(this: HandwritingPlugin): void {
		void this.startLocalCodexService().catch(error =>
			console.error("[handwriting] Codex service startup failed", error));
	}

	function stopLocalCodexService(this: HandwritingPlugin): void {
		this.codexService?.stop();
		// The null-out is load-bearing: stop() is sticky (`stopped` never
		// resets), so re-enabling the feature must build a fresh instance.
		this.codexService = null;
	}

	/** The redraw loop both transcription modals hand their figure cards.
	 * Everything Codex draws passes sanitizeFigureSvg before any preview. */
	function figureRedrawer(this: HandwritingPlugin): FigureRedrawer {
		return async (images, feedback, previous, context, signal, progress) => {
			if (signal.aborted) throw new Error("Recognition cancelled.");
			if (Platform.isDesktopApp) {
				progress("Starting the recognition service on this laptop...");
				await this.startLocalCodexService();
			}
			return sanitizeFigureSvg(await redrawFigureImage({ url: this.settings.codexServiceUrl,
				token: this.settings.codexServiceToken, model: this.settings.codexModel },
				images, feedback, previous, context, signal, progress));
		};
	}

	/** Loads the note's own embedded images from a section range, as redraw
	 * context. The markdown is captured when the dialog opens, matching the
	 * anchors the snapshot was built against. */
	function noteImageLoader(this: HandwritingPlugin, markdown: string, file: TFile): (from: number, to: number | null) => Promise<string[]> {
		return (from, to) => loadNoteContextImages(this.app, file, embeddedImageLinks(markdown, from, to));
	}

	/**
	 * Commit a reviewed transcription: validate the ink to remove, write each
	 * figure embed as an .svg beside the note, swap its token for the embed
	 * link, insert, and only then remove the replaced ink. The insert itself
	 * re-checks that the note has not changed since the dialog opened, so the
	 * awaits before it cannot smuggle text into a different note. The modals
	 * AWAIT this promise: a rejection lands in the dialog's status line with
	 * the review intact, and any embed file already written for the refused
	 * insert is taken back out of the vault rather than orphaned.
	 */
	async function insertTranscription(this: HandwritingPlugin, overlay: TranscribedInkHost, file: TFile,
		insert: (blocks: TranscriptionBlock[], placement: NotePlacement, combined: string) => void,
		blocks: TranscriptionBlock[], placement: NotePlacement, combined: string,
		remove: NoteStrokeSnapshot[], embeds: FigureEmbed[]): Promise<void> {
		if (remove.length) overlay.validateTranscribedInk(file.path, remove);
		const links = new Map<string, string>();
		const base = stripMarkdownExtension(file.path);
		const created: string[] = [];
		try {
			for (const embed of embeds) {
				const target = await this.firstFreePath(n => `${base}.figure-${n}.svg`);
				await this.app.vault.create(target, embed.svg);
				created.push(target);
				links.set(embed.token, `![[${target}]]`);
			}
			const resolve = (text: string): string => {
				for (const [token, link] of links) text = text.split(token).join(link);
				return text;
			};
			insert(blocks.map(block => ({ markdown: resolve(block.markdown), offset: block.offset })), placement, resolve(combined));
		} catch (error) {
			for (const path of created) {
				try { await this.app.vault.adapter.remove(path); }
				catch { /* An unremovable orphan still beats a broken embed link. */ }
			}
			throw error;
		}
		if (remove.length) overlay.removeTranscribedInk(file.path, remove);
	}

export function installCodexPlugin(proto: HandwritingPlugin): void {
	installMethods(proto, {
		getLocalCodexService,
		localCodexModelSelection,
		signInToCodex,
		startLocalCodexService,
		startLocalCodexServiceQuietly,
		stopLocalCodexService,
		figureRedrawer,
		noteImageLoader,
		insertTranscription,
	});
}
