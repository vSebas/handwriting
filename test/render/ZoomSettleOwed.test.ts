/**
 * A PINCH SETTLE REFUSED UNDER A PEN CONTACT IS OWED, NOT DROPPED.
 *
 * The iPad report: pinch-zoom with Infinite Canvas on, and after release the
 * strokes stay at the OLD size - the raster never adopts the new scale. The
 * mechanism: iOS can deliver the gesture's end while a pen contact already
 * holds the frame lock, and `commitCameraScale` refuses every commit while
 * `frame.locked` (the frozen-pen-pipeline rule). The settle's commit was that
 * refusal's only consumer, and nothing downstream ever retried - the raster
 * kept the pre-gesture scale for the life of the editor.
 *
 * The contract pinned here: the refusal happens (premise), nothing commits
 * while the pen holds the frame, and the pen LIFT replays the settle - a
 * commit at the gesture's final scale lands, the preview is down, and the
 * raster bookkeeping agrees with the camera.
 *
 * Failing-first: on the pre-fix tree the premise rows pass and `afterLift`
 * has no commit at all - the exact frozen state the report describes.
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import css from "../../styles.css?raw";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";

let browser: Browser, bundle: string;

beforeAll(async () => {
	const b = await build({
		entryPoints: [fileURLToPath(new URL("./scrollColumnAnchorPage.ts", import.meta.url))],
		bundle: true,
		write: false,
		format: "iife",
		platform: "browser",
		alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) },
	});
	bundle = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true });
}, 180_000);

afterAll(async () => {
	await browser?.close();
});

const PANE = { w: 945, h: 834 } as const;

it("a settle refused under a pen contact re-rasters at pen lift instead of freezing the old scale", async () => {
	const page = await browser.newPage({ viewport: { width: PANE.w, height: PANE.h }, deviceScaleFactor: 2 });
	const errors: string[] = [];
	page.on("pageerror", e => errors.push(e.message));
	try {
		await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
		await page.addScriptTag({ content: bundle });
		const result = await page.evaluate(([cx, cy]) =>
			(window as any).scrollColumnAnchor.runTearLockedSettle(cx, cy),
			[PANE.w / 2, PANE.h / 2] as const) as {
			whileLocked: { scaleNow: number; refused: number; landed: number };
			afterLift: { scaleNow: number; rasterScale: number; landed: number[]; preview: boolean };
		};

		// PREMISE rows: these pass on the broken tree too, and prove the rig
		// reached the refusal rather than never pinching at all.
		expect(result.whileLocked.scaleNow, "the gesture zoomed (300 -> 450 spread)").toBeGreaterThan(1.2);
		expect(result.whileLocked.refused, "the settle's commit was refused under the lock").toBeGreaterThanOrEqual(1);
		expect(result.whileLocked.landed, "nothing commits while the pen holds the frame").toBe(0);

		// THE FIX: pen lift pays the owed settle. On the pre-fix tree this
		// list is empty - no commit ever happens again, the frozen raster.
		const settled = result.afterLift.landed.filter(scale => Math.abs(scale - result.afterLift.scaleNow) < 1e-6);
		expect(settled.length, `a commit at the final scale ${result.afterLift.scaleNow} landed after pen lift (all landed: ${JSON.stringify(result.afterLift.landed)})`).toBeGreaterThanOrEqual(1);
		expect(result.afterLift.preview, "no preview outlives the gesture").toBe(false);
		expect(result.afterLift.rasterScale, "the raster bookkeeping agrees with the camera").toBe(result.afterLift.scaleNow);
		expect(errors, "no page errors across the gesture").toEqual([]);
	} finally {
		await page.close();
	}
}, 120_000);
