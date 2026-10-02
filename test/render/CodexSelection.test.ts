import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import css from "../../styles.css?raw";
import { chromium, type Browser, type Page } from "playwright";

/**
 * The lasso transcription modal in a real browser: tiles reach the
 * recognizer, insertion waits for a reviewed transcription, the replace-ink
 * toggle rides along with the insert, closing aborts, and without an insert
 * seam (PDF ink) the modal offers copy only.
 */
let browser: Browser, page: Page, source: string;
const errors: string[] = [];
beforeAll(async () => {
	const bundle = await build({ stdin: { contents: `
		import { CodexSelectionModal } from "./src/math/CodexSelectionModal";
		import { noteInkSnapshot } from "./src/math/WholeNoteInk";
		import { installObsidianDom } from "./test/render/obsidianDom";
		installObsidianDom();
		const stroke = (id: string, y: number) => ({ id, tool: "pen", color: "black", width: 2,
			createdAt: Number(id.replace(/\\D/g, "")) || 1, bbox: { x: 0, y, width: 8, height: 12 },
			points: [{ x: 0, y, t: 0, pressure: .5 }, { x: 8, y: y + 12, t: 20, pressure: .5 }] });
		const state = { inserted: [], images: 0, signal: null, resolve: null, modal: null,
			build(withInsert: boolean) {
				const modal = new CodexSelectionModal({}, noteInkSnapshot([stroke("s1", 0), stroke("s2", 40)]),
					(images: string[], signal: AbortSignal) => {
						state.images = images.length;
						state.signal = signal;
						return new Promise(resolve => { state.resolve = resolve; });
					},
					withInsert ? (markdown: string, replaceInk: boolean) => state.inserted.push({ markdown, replaceInk }) : undefined);
				state.modal = modal;
				modal.open();
			} };
		(window as any).selTest = state;
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

const output = () => page.locator('textarea[aria-label="Recognized Markdown"]');
async function transcribed(markdown: string) {
	await page.getByRole("button", { name: "Transcribe selection" }).click();
	await page.waitForFunction(() => (window as any).selTest.resolve !== null);
	await page.evaluate(value => (window as any).selTest.resolve(value), markdown);
	await page.waitForFunction(() => !(document.querySelector('textarea[aria-label="Recognized Markdown"]') as HTMLTextAreaElement).disabled);
}

describe("lasso transcription review", () => {
	it("inserts only a reviewed transcription, honouring the replace-ink toggle", async () => {
		await page.evaluate(() => (window as any).selTest.build(true));
		// Inserting before transcribing is refused with guidance, not a commit.
		await page.getByRole("button", { name: "Insert at saved cursor" }).click();
		expect(await page.locator('[role="status"]').textContent()).toContain("Transcribe and review");
		expect(await page.evaluate(() => (window as any).selTest.inserted)).toEqual([]);
		await transcribed("Line one and $x^2$");
		expect(await page.evaluate(() => (window as any).selTest.images)).toBeGreaterThanOrEqual(1);
		expect(await output().inputValue()).toBe("Line one and $x^2$");
		await page.locator("input[type=checkbox]").check();
		await page.getByRole("button", { name: "Insert at saved cursor" }).click();
		expect(await page.evaluate(() => (window as any).selTest.inserted))
			.toEqual([{ markdown: "Line one and $x^2$", replaceInk: true }]);
		expect(errors).toEqual([]);
	});

	it("closing mid-transcription aborts and a late result changes nothing", async () => {
		await page.evaluate(() => (window as any).selTest.build(true));
		await page.getByRole("button", { name: "Transcribe selection" }).click();
		await page.waitForFunction(() => (window as any).selTest.signal !== null);
		await page.evaluate(() => (window as any).selTest.modal.close());
		expect(await page.evaluate(() => (window as any).selTest.signal.aborted)).toBe(true);
		await page.evaluate(() => (window as any).selTest.resolve("late"));
		// close() emptied the modal's DOM; the field itself shows the late
		// result was dropped rather than written into a dead textarea.
		expect(await page.evaluate(() => (window as any).selTest.modal.output.value)).toBe("");
		expect(await page.evaluate(() => (window as any).selTest.inserted)).toEqual([]);
		expect(errors).toEqual([]);
	});

	it("without an insert seam it offers copy only and says where the text goes", async () => {
		await page.evaluate(() => (window as any).selTest.build(false));
		expect(await page.getByRole("button", { name: "Insert at saved cursor" }).count()).toBe(0);
		expect(await page.locator("input[type=checkbox]").count()).toBe(0);
		expect(await page.getByRole("button", { name: "Copy Markdown" }).count()).toBe(1);
		expect(await page.getByText("Copy the Markdown into a note.").count()).toBe(1);
		expect(errors).toEqual([]);
	});
});
