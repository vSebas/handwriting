import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import css from "../../styles.css?raw";
import { chromium, type Browser, type Page } from "playwright";

/**
 * The whole-note review modal, driven in a real browser: section cards,
 * reordering, the replace-ink toggle forcing matched placement, the
 * twelve-section guard, and what an insert actually commits. The modal is
 * DOM-event-wired throughout, so the browser suite is where its behaviour is
 * pinned (the unit obsidian stub is deliberately inert).
 */
let browser: Browser, page: Page, source: string;
const errors: string[] = [];
beforeAll(async () => {
	const bundle = await build({ stdin: { contents: `
		import { WholeNoteRecognitionModal } from "./src/math/WholeNoteRecognitionModal";
		import { noteInkSnapshot } from "./src/math/WholeNoteInk";
		import { sanitizeFigureSvg } from "./src/math/NoteFigures";
		import { installObsidianDom } from "./test/render/obsidianDom";
		installObsidianDom();
		const stroke = (id: string, y: number) => ({ id, tool: "pen", color: "black", width: 2,
			createdAt: Number(id.replace(/\\D/g, "")) || 1, bbox: { x: 0, y, width: 8, height: 12 },
			points: [{ x: 0, y, t: 0, pressure: .5 }, { x: 8, y: y + 12, t: 20, pressure: .5 }] });
		const state = { commits: [], recognized: 0, count: 0, hold: false, resolve: null, signal: null, modal: null,
			figures: [], redraws: [], redrawSvg: '<svg viewBox="0 0 4 4"><path d="M0 0 L4 4"/></svg>',
			failCommit: false, holdRedraw: false, redrawSignals: [], releaseCommit: null,
			sanitize: (svg: string) => sanitizeFigureSvg(svg),
			// One anchor per section at y = i*100, one stroke per section at y = i*100 + 20:
			// every anchor after the first lands between strokes, so noteInkSections
			// yields exactly \`sections\` groups with anchor offsets 0..sections-1.
			build(sections: number) {
				const anchors = Array.from({ length: sections }, (_, i) => ({ offset: i, y: i * 100, label: "Anchor " + i }));
				const strokes = Array.from({ length: sections }, (_, i) => stroke("s" + (i + 1), i * 100 + 20));
				const modal = new WholeNoteRecognitionModal({}, noteInkSnapshot(strokes, anchors),
					(images: string[], signal: AbortSignal) => {
						state.recognized++;
						state.signal = signal;
						return new Promise(resolve => {
							const text = "Section " + (++state.count);
							// The bridge guarantees a token per declared figure.
							const value = { markdown: state.figures.length ? text + "\\n\\n%%figure-1%%" : text,
								figures: state.figures };
							if (state.hold) state.resolve = () => resolve(value); else resolve(value);
						});
					},
					(result: unknown) => {
						if (state.failCommit) return Promise.reject(new Error("The note changed while recognition ran. Copy the result or reopen this dialog."));
						if (state.releaseCommit === undefined) {
							return new Promise<void>(resolve => {
								state.releaseCommit = () => { state.commits.push(result); resolve(); };
							});
						}
						state.commits.push(result);
					},
					(images: string[], feedback: string, previous: string, context: string, signal: AbortSignal) => {
						state.redraws.push({ feedback, previous, context, images: images.length });
						state.redrawSignals.push(signal);
						if (state.holdRedraw) return new Promise(() => {});
						return Promise.resolve(state.redrawSvg);
					});
				state.modal = modal;
				modal.open();
			} };
		(window as any).noteTest = state;
	`, resolveDir: fileURLToPath(new URL("../../", import.meta.url)), loader: "ts" }, bundle: true, write: false, format: "iife", platform: "browser",
		alias: { obsidian: fileURLToPath(new URL("./mathModalObsidianStub.ts", import.meta.url)) } });
	source = bundle.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true });
	page = await browser.newPage({ viewport: { width: 900, height: 1000 } });
	page.on("pageerror", error => errors.push(error.message));
});
beforeEach(async () => {
	errors.length = 0;
	await page.setContent("<!doctype html><html><body></body></html>");
	await page.addStyleTag({ content: css });
	await page.addScriptTag({ content: source });
});
afterAll(async () => browser?.close());

const combined = () => page.locator('textarea[aria-label="Combined Markdown transcription"]');
async function recognizeSections(count: number) {
	await page.evaluate(sections => (window as any).noteTest.build(sections), count);
	await page.getByRole("button", { name: "Recognize selection" }).click();
	await page.waitForFunction(expected =>
		document.querySelectorAll(".handwriting-image-result").length === expected, count);
}

describe("whole-note handwriting review", () => {
	it("recognizes one card per handwriting section and combines them in order", async () => {
		await recognizeSections(2);
		expect(await page.evaluate(() => (window as any).noteTest.recognized)).toBe(2);
		expect(await combined().inputValue()).toBe("Section 1\n\nSection 2");
		// Each card's dropdown suggests its own section's anchor.
		const anchors = await page.locator(".handwriting-image-result select").evaluateAll(
			selects => selects.map(select => (select as HTMLSelectElement).value));
		expect(anchors).toEqual(["0", "1"]);
		expect(errors).toEqual([]);
	});

	it("move up reorders the combined output", async () => {
		await recognizeSections(2);
		await page.getByRole("button", { name: "Move up" }).nth(1).click();
		expect(await combined().inputValue()).toBe("Section 2\n\nSection 1");
	});

	it("replacing ink forces matched placement and read-only combined output", async () => {
		await recognizeSections(2);
		const placement = () => page.evaluate(() => {
			const modal = (window as any).noteTest.modal;
			return { value: modal.placementSelect.value, disabled: modal.placementSelect.disabled, readOnly: modal.output.readOnly };
		});
		// Free placement first: at cursor, the combined copy is editable.
		await page.evaluate(() => {
			const modal = (window as any).noteTest.modal;
			modal.placementSelect.value = "cursor";
			modal.placementSelect.dispatchEvent(new Event("change"));
		});
		expect(await placement()).toEqual({ value: "cursor", disabled: false, readOnly: false });
		const toggle = page.locator(".handwriting-image-result input[type=checkbox]").first();
		await toggle.check();
		// Ink removal must land beside its original section, so the choice is
		// forced back, locked, and the combined copy stops being editable.
		expect(await placement()).toEqual({ value: "sections", disabled: true, readOnly: true });
		await toggle.uncheck();
		expect((await placement()).disabled).toBe(false);
		expect(errors).toEqual([]);
	});

	it("inserting with replace-ink commits the section strokes for removal", async () => {
		await recognizeSections(2);
		await page.locator(".handwriting-image-result input[type=checkbox]").first().check();
		await page.getByRole("button", { name: "Insert into this note" }).click();
		const commit = await page.evaluate(() => (window as any).noteTest.commits[0]);
		expect(commit.placement).toBe("sections");
		expect(commit.blocks).toEqual([
			{ markdown: "Section 1", offset: 0 }, { markdown: "Section 2", offset: 1 },
		]);
		expect(commit.remove.map((stroke: { id: string }) => stroke.id)).toEqual(["s1"]);
		expect(commit.combined).toBe("Section 1\n\nSection 2");
	});

	it("refuses a selection crossing more than twelve sections without recognizing", async () => {
		await page.evaluate(() => (window as any).noteTest.build(13));
		await page.getByRole("button", { name: "Recognize selection" }).click();
		await page.waitForFunction(() =>
			document.querySelector('[role="status"]')?.textContent?.includes("more than twelve"));
		expect(await page.evaluate(() => (window as any).noteTest.recognized)).toBe(0);
		expect(await page.locator(".handwriting-image-result").count()).toBe(0);
	});

	it("a detected figure becomes a card and embeds the original drawing by default", async () => {
		await page.evaluate(() => { (window as any).noteTest.figures = [{ id: 1, box: { left: 0, top: 0, right: 1, bottom: 1 } }]; });
		await recognizeSections(1);
		await page.waitForSelector(".handwriting-figure-result img");
		await page.locator(".handwriting-image-result input[type=checkbox]").first().check();
		await page.getByRole("button", { name: "Insert into this note" }).click();
		const commit = await page.evaluate(() => (window as any).noteTest.commits[0]);
		expect(commit.embeds).toHaveLength(1);
		// The default embed is the writer's EXACT ink as vector markup, on an
		// opaque backdrop so a dark theme cannot swallow it.
		expect(commit.embeds[0].svg.startsWith("<svg")).toBe(true);
		expect(commit.embeds[0].svg).toContain('fill="#ffffff"');
		expect(commit.blocks[0].markdown).toContain(commit.embeds[0].token);
		expect(commit.combined).toContain(commit.embeds[0].token);
		// The figure's ink is replaced by the embed, so it IS removed.
		expect(commit.remove.map((stroke: { id: string }) => stroke.id)).toEqual(["s1"]);
		expect(errors).toEqual([]);
	});

	it("keeping a figure as pen ink spares its strokes and strips its token", async () => {
		await page.evaluate(() => { (window as any).noteTest.figures = [{ id: 1, box: { left: 0, top: 0, right: 1, bottom: 1 } }]; });
		await recognizeSections(1);
		await page.locator(".handwriting-figure-result select").selectOption("ink");
		await page.locator(".handwriting-image-result input[type=checkbox]").first().check();
		await page.getByRole("button", { name: "Insert into this note" }).click();
		const commit = await page.evaluate(() => (window as any).noteTest.commits[0]);
		expect(commit.embeds).toEqual([]);
		expect(commit.blocks[0].markdown).toBe("Section 1");
		expect(commit.remove).toEqual([]);
		expect(errors).toEqual([]);
	});

	it("a chosen redraw is gated behind accept and iterates on feedback", async () => {
		await page.evaluate(() => { (window as any).noteTest.figures = [{ id: 1, box: { left: 0, top: 0, right: 1, bottom: 1 } }]; });
		await recognizeSections(1);
		await page.locator(".handwriting-figure-result select").selectOption("redraw");
		// Nothing Codex drew may reach a note unreviewed: inserting before
		// accepting is refused with guidance, not committed.
		await page.getByRole("button", { name: "Insert into this note" }).click();
		expect(await page.locator('[role="status"]').first().textContent()).toContain("Accept the Codex redraw");
		expect(await page.evaluate(() => (window as any).noteTest.commits.length)).toBe(0);
		await page.getByRole("button", { name: "Ask Codex to redraw" }).click();
		await page.waitForFunction(() => {
			const preview = document.querySelector('img[alt="Codex redraw of the figure"]') as HTMLImageElement | null;
			return preview !== null && !preview.hidden && preview.src.startsWith("data:image/svg+xml");
		});
		// The section's transcription and its ink overview ride along as
		// context, so Codex knows what the drawing is supposed to be.
		expect(await page.evaluate(() => (window as any).noteTest.redraws))
			.toEqual([{ feedback: "", previous: "", context: "Section 1", images: 2 }]);
		// Request changes iterates on the PREVIOUS redraw, not from scratch.
		await page.locator('textarea[aria-label="Describe what the redraw should change"]').fill("thicker axes");
		await page.getByRole("button", { name: "Request changes" }).click();
		await page.waitForFunction(() => (window as any).noteTest.redraws.length === 2);
		// The previous sent back for iteration, and the embed that commits,
		// are the BACKED redraw: opaque white rect behind Codex's shapes.
		const svg = await page.evaluate(() => (window as any).noteTest.redrawSvg);
		const backed = '<svg viewBox="0 0 4 4"><rect x="0" y="0" width="4" height="4" fill="#ffffff"/><path d="M0 0 L4 4"/></svg>';
		expect(svg.includes("ffffff")).toBe(false);
		expect(await page.evaluate(() => (window as any).noteTest.redraws[1]))
			.toEqual({ feedback: "thicker axes", previous: backed, context: "Section 1", images: 2 });
		await page.getByRole("button", { name: "Accept redraw" }).click();
		await page.getByRole("button", { name: "Insert into this note" }).click();
		const commit = await page.evaluate(() => (window as any).noteTest.commits[0]);
		expect(commit.embeds).toEqual([{ token: expect.stringMatching(/^%%figure-hw\d+%%$/), svg: backed }]);
		expect(errors).toEqual([]);
	});

	it("a failed insert lands in the status line with the review intact", async () => {
		await recognizeSections(2);
		await page.evaluate(() => { (window as any).noteTest.failCommit = true; });
		await page.getByRole("button", { name: "Insert into this note" }).click();
		// The dialog stays open with every reviewed card, not a false success.
		await page.waitForFunction(() =>
			document.querySelector('[role="status"]')?.textContent?.includes("The note changed"));
		expect(await page.locator(".handwriting-image-result").count()).toBe(2);
		expect(errors).toEqual([]);
	});

	it("locks the review while an insert is committing", async () => {
		await recognizeSections(2);
		// Arm the holdable commit (undefined = hold; see the harness fake).
		await page.evaluate(() => { (window as any).noteTest.releaseCommit = undefined; });
		await page.getByRole("button", { name: "Insert into this note" }).click();
		// The blocks and removal list are captured at click time, so every
		// review control must be dead until the commit settles - a section
		// removed during the await would still have inserted.
		await page.waitForFunction(() => (window as any).noteTest.modal.contentEl.inert === true);
		await page.evaluate(() => (window as any).noteTest.releaseCommit());
		await page.waitForFunction(() => (window as any).noteTest.commits.length === 1);
		expect(errors).toEqual([]);
	});

	it("removing a section cancels its running figure redraw", async () => {
		await page.evaluate(() => {
			(window as any).noteTest.figures = [{ id: 1, box: { left: 0, top: 0, right: 1, bottom: 1 } }];
			(window as any).noteTest.holdRedraw = true;
		});
		await recognizeSections(1);
		await page.locator(".handwriting-figure-result select").selectOption("redraw");
		await page.getByRole("button", { name: "Ask Codex to redraw" }).click();
		await page.waitForFunction(() => (window as any).noteTest.redrawSignals.length === 1);
		expect(await page.evaluate(() => (window as any).noteTest.redrawSignals[0].aborted)).toBe(false);
		// Removing the section aborts its redraw, which is what sends /cancel
		// and frees the laptop's single-flight slot for the next request.
		await page.getByRole("button", { name: "Remove" }).click();
		expect(await page.evaluate(() => (window as any).noteTest.redrawSignals[0].aborted)).toBe(true);
		expect(errors).toEqual([]);
	});

	it("the SVG sanitizer strips scripts, handlers and external references", async () => {
		const cleaned = await page.evaluate(() => (window as any).noteTest.sanitize(
			'<svg viewBox="0 0 10 10" onload="alert(1)"><script>alert(2)</script>' +
			'<path d="M0 0 L5 5" fill="url(http://evil.example/x)"/>' +
			'<rect width="2" height="2" style="background-image: \\75rl(https://evil.example/leak.png)"/>' +
			'<a href="https://evil.example"><circle r="2"/></a></svg>'));
		expect(cleaned).not.toContain("script");
		expect(cleaned).not.toContain("onload");
		// Including the CSS-escaped form (\\75rl = url): style goes entirely.
		expect(cleaned).not.toContain("evil.example");
		expect(cleaned).not.toContain("style=");
		expect(cleaned).toContain("<path");
		const refused = await page.evaluate(() => {
			try { (window as any).noteTest.sanitize("I am sorry, I cannot draw that."); return null; }
			catch (error) { return (error as Error).message; }
		});
		expect(refused).toContain("did not return an SVG");
		expect(errors).toEqual([]);
	});

	it("closing mid-recognition aborts the request and discards its late result", async () => {
		await page.evaluate(() => { (window as any).noteTest.hold = true; (window as any).noteTest.build(1); });
		await page.getByRole("button", { name: "Recognize selection" }).click();
		await page.waitForFunction(() => (window as any).noteTest.signal !== null);
		await page.evaluate(() => (window as any).noteTest.modal.close());
		expect(await page.evaluate(() => (window as any).noteTest.signal.aborted)).toBe(true);
		await page.evaluate(() => (window as any).noteTest.resolve());
		expect(await page.locator(".handwriting-image-result").count()).toBe(0);
		expect(errors).toEqual([]);
	});
});
