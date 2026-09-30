/**
 * A lasso drag torn down mid-gesture must ROLL BACK, not linger (the sync-loss
 * sender-side hole).
 *
 * `lassoMove` translates the selected strokes' committed coordinates in place
 * on every frame; only `lassoUp` saves and pushes the history op. Every other
 * way a gesture ends - a note switch, an unmount, a second finger starting a
 * pinch, `strokeAbandoned` - reaches `resetGestureState`, which used to null
 * `dragFrom`/`dragTotal` and nothing else: the strokes stayed moved on screen
 * and in the session with NO save scheduled and no op, so the sidecar (and
 * anything syncing it) held the old positions while the screen showed the new
 * ones. `rollbackLassoDrag` closes that exactly the way `rollbackSpaceMove`
 * closes the same hole for the insert-space gesture: invert the accumulated
 * delta against the ORIGINAL note (resolved by history identity, because a
 * note switch has already changed filePath by the time reset runs) and save
 * the restored state.
 *
 * Same `Object.create` rig as `AbandonedGestureStandsDown.test.ts`, for the
 * same reason: `InkOverlayPlugin.mount()` wants real canvases, so nothing in
 * this repo constructs one.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { InkOverlayPlugin, inlineInk, releaseTipModes } from "./InkOverlay";
import { InkStroke } from "../ink/Stroke";
import { PageData } from "../model/PageData";
import { SelectionModel } from "../objects/SelectionModel";
import { Camera } from "../camera/Camera";
import { StrokeFrame } from "./StrokeFrame";

interface Proto {
	strokeAbandoned(this: unknown): void;
	cancelFingerInkForPinch(this: unknown): void;
}

/** Unique per test: the session store never evicts, so reusing one path
 * would accumulate a committed "A" per beforeEach. */
let noteCounter = 0;
let NOTE = "lasso-abandon-0.md";

function stroke(id: string, x = 10): InkStroke {
	return {
		id,
		color: "#000",
		width: 2,
		tool: "pen",
		points: [
			{ x, y: 10, pressure: 0.5, t: 0 },
			{ x: x + 10, y: 20, pressure: 0.5, t: 8 },
		],
		bbox: { x: x - 2, y: 8, width: 16, height: 16 },
		createdAt: 1,
	} as InkStroke;
}

function makeRig() {
	const noop = (): void => undefined;
	const layer = () => {
		const l = { cleared: 0, clear: () => void l.cleared++ };
		return l;
	};
	const inst = Object.create(InkOverlayPlugin.prototype) as Record<string, unknown>;

	inst.mode = "lasso";
	inst.builder = null;
	inst.camera = new Camera();
	inst.cssScale = 1;
	inst.cssWidth = 800;
	inst.cssHeight = 600;
	inst.selection = new SelectionModel();
	inst.erased = [];
	inst.erasePieces = new Set();
	inst.eraseFrom = [];
	inst.eraseWhole = false;
	inst.lassoPts = [];
	inst.lassoActive = false;
	inst.dragFrom = null;
	inst.dragTotal = null;
	inst.dragIds = [];
	inst.dragHistoryIdentity = null;
	inst.spaceLineY = null;
	inst.spaceIds = [];
	inst.spaceBounds = null;
	inst.spacePlan = null;
	inst.spaceTotalDy = 0;
	inst.spaceHistoryIdentity = null;
	inst.panLast = null;
	inst.hoverWatchdog = null;
	inst.frameTicking = true;
	inst.strokePenGesture = true;
	inst.selectionDeleteKeys = { reset: noop };
	const frame = new StrokeFrame();
	frame.begin();
	inst.frame = frame;
	inst.wet = layer();
	inst.highlightWet = layer();
	inst.tail = { cleared: 0, clearAll: noop };
	inst.highlightWetCanvas = { setCssStyles: noop };
	inst.penCursorEl = { setCssStyles: noop };
	inst.eraserEl = { setCssStyles: noop };
	inst.mobileTools = { setInking: noop, refresh: noop, closeInkSliders: noop };
	inst.frontierCache = { invalidate: noop };
	inst.view = {
		dom: { ownerDocument: { defaultView: { setTimeout: vi.fn(() => 1), clearTimeout: vi.fn() } } },
		scrollDOM: { classList: { add: noop, remove: noop } },
	};

	const proto = InkOverlayPlugin.prototype as unknown as Proto;
	return { inst, proto };
}

/** Seed an in-flight drag exactly as lassoDown + lassoMove leave it. */
function seedDrag(inst: Record<string, unknown>, ids: string[], dx: number, dy: number): void {
	inst.dragHistoryIdentity = inlineInk.captureHistoryIdentity(NOTE);
	inst.dragIds = [...ids];
	inst.dragFrom = { x: 0, y: 0 };
	inst.dragTotal = { dx, dy };
	inlineInk.moveStrokes(NOTE, ids, dx, dy);
}

const pointX = (): number | undefined => inlineInk.strokes(NOTE)[0]?.points[0]?.x;

describe("an abandoned lasso drag rolls back and persists the restored state", () => {
	const scheduled: PageData[] = [];

	beforeEach(async () => {
		releaseTipModes();
		// settle() waits on window.setTimeout; node has no window.
		(globalThis as { window?: unknown }).window = globalThis;
		scheduled.length = 0;
		NOTE = `lasso-abandon-${++noteCounter}.md`;
		inlineInk.attachHost({
			readPageId: () => `pid-${noteCounter}`,
			claimId: async () => ({ pageId: `pid-${noteCounter}` }),
			loadSidecar: async () => null,
			scheduleSidecar: (_id, page) => void scheduled.push(page),
			notify: () => undefined,
		});
		await inlineInk.ensureLoaded(NOTE);
		inlineInk.commit(NOTE, stroke("A", 10));
		await inlineInk.settle();
		scheduled.length = 0;
	});

	it("a note switch/unmount mid-drag restores the geometry and schedules the restored page", async () => {
		const rig = makeRig();
		seedDrag(rig.inst, ["A"], 7, -3);
		expect(pointX(), "the live drag translated the committed stroke").toBe(17);

		rig.proto.strokeAbandoned.call(rig.inst);

		expect(pointX(), "the abandoned drag stayed applied").toBe(10);
		expect(rig.inst.dragFrom).toBe(null);
		expect(rig.inst.dragTotal).toBe(null);
		expect(rig.inst.dragIds).toEqual([]);
		expect(rig.inst.dragHistoryIdentity).toBe(null);
		await inlineInk.settle();
		const last = scheduled[scheduled.length - 1];
		expect(last, "no save was scheduled for the restored state").toBeDefined();
		expect(last!.strokes[0]?.points[0]?.x).toBe(10);
	});

	it("a second-finger pinch cancel takes the same rollback", () => {
		const rig = makeRig();
		seedDrag(rig.inst, ["A"], 4, 4);
		expect(pointX()).toBe(14);

		rig.proto.cancelFingerInkForPinch.call(rig.inst);

		expect(pointX()).toBe(10);
	});

	it("a completed drag is not inverted a second time by a later reset", () => {
		const rig = makeRig();
		// lassoUp already committed: the drag fields are cleared, the move stands.
		inlineInk.moveStrokes(NOTE, ["A"], 7, 0);
		expect(pointX()).toBe(17);

		rig.proto.strokeAbandoned.call(rig.inst);

		expect(pointX(), "a committed move was rolled back").toBe(17);
	});

	it("a zero-delta drag rolls back to a no-op (no save scheduled)", async () => {
		const rig = makeRig();
		seedDrag(rig.inst, ["A"], 0, 0);

		rig.proto.strokeAbandoned.call(rig.inst);

		expect(pointX()).toBe(10);
		await inlineInk.settle();
		expect(scheduled).toEqual([]);
	});
});
