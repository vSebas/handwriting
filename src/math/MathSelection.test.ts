import { expect, it } from "vitest";
import { InkOverlayPlugin } from "../inline/InkOverlay";
import { PdfInkController } from "../pdf/PdfInkController";
import { SelectionModel } from "../objects/SelectionModel";
import type { InkStroke } from "../ink/Stroke";

it("reads only the active overlay's lasso, preserving strokes and selection", () => {
	const selection = new SelectionModel();
	selection.selectExactly(["selected", "deleted-elsewhere"]);
	const strokes = [{ id: "other" }, { id: "selected" }] as InkStroke[];
	const overlay = Object.create(InkOverlayPlugin.prototype);
	Object.assign(overlay, { selection, strokesHere: () => strokes });
	const result = overlay.selectedStrokesForMath();
	 expect(result).toEqual([strokes[1]]);
	 expect(selection.strokeIds).toEqual(["selected", "deleted-elsewhere"]);
	 expect(strokes).toHaveLength(2);
});

it("reads PDF annotations from the selection's page rather than the currently drawn page", () => {
	const pages: number[] = [];
	const strokes = [{ id: "other" }, { id: "selected" }] as InkStroke[];
	const controller = Object.create(PdfInkController.prototype);
	Object.assign(controller, { selected: ["selected"], selectionPage: 2, strokes: (page: number) => { pages.push(page); return strokes; } });
	expect(controller.selectedStrokesForMath()).toEqual([strokes[1]]);
	expect(pages).toEqual([2]);
	expect(controller.selected).toEqual(["selected"]);
});
