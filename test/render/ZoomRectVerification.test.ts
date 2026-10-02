/**
 * A ZOOM THE ENGINE KEEPS OUT OF ITS RECTS IS A ZOOM THE OVERLAY MUST NOT USE.
 *
 * The iPad "zoom-out keeps the old stroke size" report, root-caused by the
 * beta.18 presentation trace (2026-10-01): that iPadOS WebKit parses CSS
 * zoom, echoes it from computed style, visibly scales the page - and leaves
 * getBoundingClientRect at LAYOUT size. Every measurement the overlay makes
 * runs in rect units, so `effectiveScale` read 1.0 after every settle, the
 * camera booked the difference as an external counter-scale (ext = 1/zoom in
 * all four settles of the trace), ink rastered at full size, and pen input
 * mapped through the same wrong divisor (the zoomed pen offset).
 *
 * The fix extends the once-per-takeover zoom verification with a GEOMETRY
 * check: a host whose rect still spans pane/next after the zoom write is on
 * an engine whose rects exclude zoom, and flips to the transform fallback -
 * which moves rects identically on every engine.
 *
 * The iPad engine is modelled here in Chromium by stripping the host's zoom
 * back out of the subtree's rects (runTearZoomlessRects). Failing-first: on
 * the pre-fix tree the simulated cell keeps the zoom host (hostZoomSupport
 * true) and the strokes keep their pre-pinch pixel size after a zoom-out -
 * the device symptom, reproduced. The control cell pins the healthy engine:
 * no stub, zoom host kept, strokes rescale.
 */
import { afterAll, beforeAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";

let browser: Browser, bundle: string;

beforeAll(async () => {
	const b = await build({
		entryPoints: [fileURLToPath(new URL("./scrollColumnAnchorPage.ts", import.meta.url))],
		bundle: true, write: false, format: "iife", platform: "browser",
		alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) },
	});
	bundle = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true });
}, 180_000);
afterAll(async () => { await browser?.close(); });

/** Row-profile of blue ink: heights of consecutive inked-row bands. X-shift tolerant. */
async function bands(page: Page): Promise<number[]> {
	const shot = (await page.screenshot()).toString("base64");
	return await page.evaluate(async b64 => {
		const img = new Image();
		img.src = `data:image/png;base64,${b64}`;
		await img.decode();
		const c = document.createElement("canvas");
		c.width = img.naturalWidth; c.height = img.naturalHeight;
		const g = c.getContext("2d", { willReadFrequently: true })!;
		g.drawImage(img, 0, 0);
		const d = g.getImageData(0, 0, c.width, c.height).data;
		const out: number[] = [];
		let run = 0;
		for (let y = 0; y < c.height; y++) {
			let hit = 0;
			for (let x = 0; x < c.width; x += 2) {
				const i = (y * c.width + x) * 4;
				if (d[i + 2]! > 140 && d[i]! < 110 && d[i + 1]! < 110) hit++;
			}
			if (hit >= 3) run++; else if (run) { out.push(run); run = 0; }
		}
		if (run) out.push(run);
		return out;
	}, shot);
}

for (const arm of [
	{ name: "an engine whose rects exclude zoom flips to the transform host and the strokes rescale", zoomless: true },
	{ name: "an engine whose rects include zoom keeps the zoom host and the strokes rescale", zoomless: false },
]) it(arm.name, async () => {
	const page = await browser.newPage({ viewport: { width: 945, height: 834 }, deviceScaleFactor: 2 });
	const errors: string[] = [];
	page.on("pageerror", e => errors.push(e.message));
	try {
		await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
		await page.addScriptTag({ content: bundle });
		await page.evaluate(() => { (globalThis as any).__HW_FAMILYC = { inkBbox: { frontier: 1600, color: "#0000ff" } }; });
		await page.evaluate(() => (window as any).scrollColumnAnchor.runTearMount(1, 0, null, true, { fx: 0.5, fy: 0.5 }));
		if (arm.zoomless) await page.evaluate(() => (window as any).scrollColumnAnchor.runTearZoomlessRects());
		const before = await bands(page);
		expect(before.length, "premise: seeded ink is visible before the pinch").toBeGreaterThan(0);
		// A real zoom-out through the real router, 1 -> 0.3.
		await page.evaluate(() => (window as any).scrollColumnAnchor.runTearLockedSettle(945 / 2, 834 / 2, 90, false, false));
		const after = await bands(page);
		const state = await page.evaluate(() => (window as any).scrollColumnAnchor.runTearHostState()) as
			{ hostZoomSupport: boolean | null; hostZoom: string; hostTransform: string; cssScale: number; pinchScaleNow: number };

		// The strokes must RESCALE - the device symptom was bands keeping
		// their pre-pinch height. 0.3x of the before-height, with room for
		// anti-aliased edges; the broken tree leaves them at full height.
		const tallest = Math.max(...before);
		for (const band of after) {
			expect(band, `an ink band kept its pre-pinch size (before=${JSON.stringify(before)} after=${JSON.stringify(after)})`)
				.toBeLessThan(tallest * 0.55);
		}
		expect(after.length, "the ink is still on screen after the settle").toBeGreaterThan(0);

		if (arm.zoomless) {
			// The geometry check saw rects without the zoom and flipped.
			expect(state.hostZoomSupport, "the overlay did not flip to the transform host").toBe(false);
			expect(state.hostTransform, "the transform fallback carries the scale").toContain("scale(");
		} else {
			// Control: a healthy engine must NOT be misclassified.
			expect(state.hostZoomSupport, "the healthy zoom host was demoted").not.toBe(false);
			expect(state.hostZoom, "the zoom host carries the factor").not.toBe("");
		}
		expect(errors, "no page errors across the gesture").toEqual([]);
	} finally {
		await page.close();
	}
}, 120_000);
