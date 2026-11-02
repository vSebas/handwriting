/**
 * The two Codex transcription commands (the fork's feature): the lasso and
 * the whole-note transcriptions, both gated on the setting so they vanish from
 * the palette while the feature is off. registerCodexCommands is a method of
 * HandwritingPlugin, installed on its prototype when main.ts loads and called
 * from onload right after registerCommands.
 */
import { installMethods } from "../inline/InstallMethods";
import { Notice, Platform } from "obsidian";
import { inlineInk, overlayForActiveEditor } from "../inline/InkOverlay";
import { runDetached } from "../util/Detached";
import { CodexSelectionModal } from "../math/CodexSelectionModal";
import { recognizeWholeNoteImages } from "../math/CodexService";
import { captureWholeNoteInsertionTarget, noteInkSnapshot } from "../math/WholeNoteInk";
import { WholeNoteRecognitionModal } from "../math/WholeNoteRecognitionModal";
import type { HandwritingPlugin } from "../main";

declare module "../main" {
	interface HandwritingPlugin {
		registerCodexCommands(): void;
	}
}

	function registerCodexCommands(this: HandwritingPlugin): void {
		this.addCommand({
			id: "recognize-selected-handwriting",
			name: "Lasso: transcribe handwriting",
			checkCallback: checking => {
				if (!this.settings.codexEnabled) return false;
				const surface = this.activeInkSurface();
				if (!surface) return false;
				if (!checking) {
					try {
						const strokes = surface.kind === "inline"
							? surface.overlay.selectedStrokesForMath()
							: surface.controller.selectedStrokesForMath();
						const active = this.app.workspace.activeEditor;
						const file = surface.kind === "inline" ? active?.file : null;
						const overlay = surface.kind === "inline" ? surface.overlay : null;
						// Anchors let replace-ink insert BESIDE the lassoed ink's
						// own section instead of at the saved cursor.
						const noteMarkdown = overlay && active?.editor && file ? active.editor.getValue() : null;
						const anchors = noteMarkdown !== null && file
							? overlay!.transcriptionAnchors(file.path, noteMarkdown) : [];
						const source = noteInkSnapshot(strokes, anchors);
						const insert = overlay && active?.editor && file
							? captureWholeNoteInsertionTarget(active, () => this.app.workspace.activeEditor)
							: null;
						this.selectionModal?.close();
						this.selectionModal = new CodexSelectionModal(this.app, source,
							async (images, signal, progress) => {
								if (Platform.isDesktopApp) {
									progress("Starting the Codex service on this laptop...");
									await this.startLocalCodexService();
								}
								return recognizeWholeNoteImages({ url: this.settings.codexServiceUrl, token: this.settings.codexServiceToken,
									model: this.settings.codexModel }, images, signal, progress);
							}, insert && overlay && file ? (markdown, remove, embeds, anchorOffset) =>
								// Returned, not detached: the modal awaits it so a
								// refused insert surfaces in its status line.
								this.insertTranscription(overlay, file, insert,
									[{ markdown, offset: anchorOffset ?? 0 }],
									anchorOffset !== null ? "sections" : "cursor", markdown, remove, embeds)
							: undefined, this.figureRedrawer(),
							noteMarkdown !== null && file ? this.noteImageLoader(noteMarkdown, file) : undefined);
						this.selectionModal.open();
					} catch (error) {
						new Notice(`Handwriting: ${error instanceof Error ? error.message : "Could not read the selected ink."}`);
					}
				}
				return true;
			},
		});
		this.addCommand({
			id: "recognize-note-handwriting",
			name: "Transcribe all handwriting in this note",
			checkCallback: checking => {
				if (!this.settings.codexEnabled) return false;
				const active = this.app.workspace.activeEditor;
				const file = active?.file;
				if (!active?.editor || !file || file.extension.toLowerCase() !== "md") return false;
				if (!checking) runDetached((async () => {
					try {
						await inlineInk.ensureLoaded(file.path);
						if (!inlineInk.isLoaded(file.path)) throw new Error("The note's saved ink is still loading or damaged. Try again after it is available.");
						if (this.app.workspace.activeEditor !== active || active.file !== file) throw new Error("Return to the original note and try again.");
						const editor = active.editor;
						if (!editor) throw new Error("Open a Markdown editor to transcribe this note.");
						const overlay = overlayForActiveEditor(editor, file);
						if (!overlay) throw new Error("Open the note in a handwriting-enabled editor before transcribing it.");
						const anchors = overlay.transcriptionAnchors(file.path, editor.getValue());
						const snapshot = noteInkSnapshot(inlineInk.strokes(file.path), anchors);
						const insert = captureWholeNoteInsertionTarget(active, () => this.app.workspace.activeEditor);
						this.wholeNoteModal?.close();
						this.wholeNoteModal = new WholeNoteRecognitionModal(this.app, snapshot,
							async (images, signal, progress) => {
								if (Platform.isDesktopApp) {
									progress("Starting the recognition service on this laptop...");
									await this.startLocalCodexService();
								}
								const settings = { url: this.settings.codexServiceUrl, token: this.settings.codexServiceToken, model: this.settings.codexModel };
								return recognizeWholeNoteImages(settings, images, signal, progress);
							},
							// Returned, not detached: the modal awaits it so a
							// refused insert surfaces in its status line.
							result => this.insertTranscription(overlay, file, insert, result.blocks,
								result.placement, result.combined, result.remove, result.embeds),
							this.figureRedrawer(), this.noteImageLoader(editor.getValue(), file));
						this.wholeNoteModal.open();
					} catch (error) {
						new Notice(`Handwriting: ${error instanceof Error ? error.message : "Could not read note ink."}`);
					}
				})(), "transcribe note handwriting");
				return true;
			},
		});
	}

export function installRegisterCodexCommands(proto: HandwritingPlugin): void {
	installMethods(proto, {
		registerCodexCommands,
	});
}
