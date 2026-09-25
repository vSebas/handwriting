import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";

let browser: Browser, page: Page, source: string;
const candidates = ["x^2", "x_2", "\\frac{1}{\\sqrt{2\\pi\\sigma^2}} e^{-\\frac{(y-a)^2}{2\\sigma^2}}"];
const errors: string[] = [];
beforeAll(async () => {
	const bundle = await build({ stdin: { contents: `
		import { MathRecognitionModal } from "./src/math/MathRecognitionModal";
		import { installObsidianDom } from "./test/render/obsidianDom";
		installObsidianDom();
		window.mathTest = { inserted: [], signal: null, resolve: null };
		const modal = new MathRecognitionModal({}, {traces: [[[0,0,0]]]}, {
			name: "Test", description: "Local test",
			recognize: (_ink, signal) => { window.mathTest.signal = signal; return new Promise(resolve => window.mathTest.resolve = resolve); }
		}, (latex, format) => window.mathTest.inserted.push({latex, format}));
		window.mathTest.close = () => modal.close();
		modal.open();
	`, resolveDir: fileURLToPath(new URL("../../", import.meta.url)), loader: "ts" }, bundle: true, write: false, format: "iife", platform: "browser",
		alias: { obsidian: fileURLToPath(new URL("./mathModalObsidianStub.ts", import.meta.url)) } });
	source = bundle.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true });
	page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
	page.on("pageerror", error => errors.push(error.message));
});
beforeEach(async () => {
	errors.length = 0;
	await page.setContent("<!doctype html><html><body></body></html>");
	await page.addStyleTag({ content: readFileSync("styles.css", "utf8") });
	await page.addScriptTag({ content: source });
});
afterAll(async () => browser?.close());
async function recognize(values = candidates) {
	await page.getByRole("button", { name: "Recognize with Test" }).tap();
	await page.evaluate(values => (window as any).mathTest.resolve({ latex: values[0], candidates: values }), values);
	await page.waitForFunction(() => !(document.querySelector("textarea") as HTMLTextAreaElement).disabled);
}
describe("math candidate review on a touch screen", () => {
	it("selects an alternative, previews it, and inserts only after explicit confirmation", async () => {
		await recognize();
		await page.getByRole("button", { name: "Use candidate 2: x_2", exact: true }).tap();
		expect(await page.locator("textarea").inputValue()).toBe("x_2");
		expect(await page.locator(".handwriting-math-preview").textContent()).toBe("x_2");
		expect(await page.getByRole("button", { name: "Use candidate 2: x_2", exact: true }).getAttribute("aria-pressed")).toBe("true");
		expect(await page.evaluate(() => (window as any).mathTest.inserted)).toEqual([]);
		await page.getByRole("button", { name: "Insert at saved cursor" }).tap();
		expect(await page.evaluate(() => (window as any).mathTest.inserted)).toEqual([{ latex: "x_2", format: "display" }]);
		expect(errors).toEqual([]);
	});
	it("keeps manual corrections and clears the selected candidate marker", async () => {
		await recognize();
		await page.locator("textarea").fill("x^3");
		expect(await page.locator('.handwriting-math-candidate[aria-pressed="true"]').count()).toBe(0);
		await page.getByRole("button", { name: "Insert at saved cursor" }).tap();
		expect(await page.evaluate(() => (window as any).mathTest.inserted)).toEqual([{ latex: "x^3", format: "display" }]);
	});
	it("disables stale candidates while recognizing and ignores results after close", async () => {
		await recognize();
		await page.getByRole("button", { name: "Recognize with Test" }).tap();
		expect(await page.locator(".handwriting-math-candidate:disabled").count()).toBe(3);
		await page.evaluate(() => (window as any).mathTest.close());
		expect(await page.evaluate(() => (window as any).mathTest.signal.aborted)).toBe(true);
		await page.evaluate(() => (window as any).mathTest.resolve({ latex: "late", candidates: ["late", "stale"] }));
		expect(await page.locator(".handwriting-math-candidate").count()).toBe(0);
		expect(await page.evaluate(() => (window as any).mathTest.inserted)).toEqual([]);
		expect(errors).toEqual([]);
	});
	it("fits long candidate expressions within a narrow viewport with touch-sized buttons", async () => {
		await recognize();
		const boxes = await page.locator(".handwriting-math-candidate").evaluateAll(buttons => buttons.map(button => {
			const rect = button.getBoundingClientRect(); return { left: rect.left, right: rect.right, height: rect.height };
		}));
		for (const box of boxes) { expect(box.left).toBeGreaterThanOrEqual(0); expect(box.right).toBeLessThanOrEqual(390); expect(box.height).toBeGreaterThanOrEqual(48); }
	});
});
