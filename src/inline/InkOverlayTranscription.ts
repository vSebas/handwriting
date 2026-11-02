/**
 * The note surface's seam for Codex transcription (the fork's feature, see
 * src/math/): the anchors a transcription is placed beside, the lasso
 * strokes a recognition reads, and the two-step removal of pen ink a reviewed
 * transcription replaces. Methods of InkOverlayPlugin, installed on its
 * prototype when InkOverlay.ts loads, like every other slice.
 */
import { installMethods } from "./InstallMethods";
import type { InkStroke } from "../ink/Stroke";
import { markdownBlockAnchors, type NotePlacementAnchor, type NoteStrokeSnapshot } from "../math/WholeNoteInk";
import { inlineInk, type InkOverlayPlugin } from "./InkOverlay";

declare module "./InkOverlay" {
	interface InkOverlayPlugin {
		/** Insertion points after each Markdown block, with the note-space y
		 * of the block's last line, so handwriting is matched to the section
		 * it sits under. Throws if the note changed under the dialog. */
		transcriptionAnchors(path: string, markdown: string): NotePlacementAnchor[];
		/** Every stroke a reviewed replacement expects must still be the
		 * stroke recognition saw, byte for byte - or nothing is removed. */
		validateTranscribedInk(path: string, expected: readonly Pick<NoteStrokeSnapshot, "id" | "signature">[]): void;
		removeTranscribedInk(path: string, expected: readonly Pick<NoteStrokeSnapshot, "id" | "signature">[]): number;
		/** The lasso selection as strokes, for recognition. */
		selectedStrokesForMath(): InkStroke[];
	}
}

	function transcriptionAnchors(this: InkOverlayPlugin, path: string, markdown: string): NotePlacementAnchor[] {
		if (this.filePath() !== path || this.view.state.doc.toString() !== markdown || !(this.scale > 0)) {
			throw new Error("The note layout changed. Reopen the transcription dialog.");
		}
		return markdownBlockAnchors(markdown).map((anchor, index) => ({
			offset: anchor.offset,
			y: index === 0 && anchor.offset === 0 ? 0 : this.view.lineBlockAt(Math.min(anchor.lineStart, this.view.state.doc.length)).bottom / this.scale,
			label: anchor.label,
		}));
	}

	function validateTranscribedInk(this: InkOverlayPlugin, path: string, expected: readonly Pick<NoteStrokeSnapshot, "id" | "signature">[]): void {
		if (this.filePath() !== path || !inlineInk.isLoaded(path)) throw new Error("Return to the original loaded note before replacing handwriting.");
		const current = new Map(inlineInk.strokes(path).map(stroke => [stroke.id, stroke]));
		if (expected.some(item => !current.has(item.id) || JSON.stringify(current.get(item.id)) !== item.signature)) {
			throw new Error("Some handwriting changed since recognition. Reopen the dialog before replacing it.");
		}
	}

	function removeTranscribedInk(this: InkOverlayPlugin, path: string, expected: readonly Pick<NoteStrokeSnapshot, "id" | "signature">[]): number {
		this.validateTranscribedInk(path, expected);
		if (!expected.length) return 0;
		const removed = inlineInk.applyRemove(path, expected.map(item => item.id));
		if (removed.length !== expected.length) throw new Error("Some handwriting could not be removed. Undo the text insertion and retry.");
		this.dispatchInk({ type: "remove", path, strokes: removed.map(item => item.stroke), indices: removed.map(item => item.index) });
		this.selection.clear();
		this.scheduleRepaint();
		this.repaintPath(path);
		return removed.length;
	}

	function selectedStrokesForMath(this: InkOverlayPlugin): InkStroke[] {
		const ids = new Set(this.selection.strokeIds);
		return this.strokesHere().filter(stroke => ids.has(stroke.id));
	}

export function installTranscription(proto: InkOverlayPlugin): void {
	installMethods(proto as unknown as object, {
		transcriptionAnchors,
		validateTranscribedInk,
		removeTranscribedInk,
		selectedStrokesForMath,
	});
}
