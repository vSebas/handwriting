import { afterAll, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";

let browser: Browser, page: Page;
beforeAll(async () => {
	const bundle = await build({ stdin: { contents: `import { mathInkImage } from "./src/math/MathInkImage"; window.renderInk = mathInkImage;`,
		resolveDir: fileURLToPath(new URL("../../", import.meta.url)), loader: "ts" }, bundle: true, write: false, format: "iife", platform: "browser" });
	browser = await chromium.launch({ headless: true }); page = await browser.newPage();
	await page.setContent('<body style="background:black"></body>');
	await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
});
afterAll(async () => browser?.close());

it("crops negative coordinates, paints dots, and uses black ink on opaque white in dark mode", async () => {
	const result = await page.evaluate(async () => {
		const url = (window as any).renderInk({ traces: [[[-10,-20,0], [90,-20,1]], [[40,30,2]]] });
		const image = new Image(); image.src = url; await image.decode();
		const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
		const ctx = canvas.getContext("2d")!; ctx.drawImage(image, 0, 0);
		const pixel = (x: number, y: number) => Array.from(ctx.getImageData(x,y,1,1).data);
		return { width: image.width, height: image.height, corner: pixel(0,0), line: pixel(80,16), dot: pixel(116,116) };
	});
	expect(result).toEqual({ width: 232, height: 132, corner: [255,255,255,255], line: [0,0,0,255], dot: [0,0,0,255] });
});

it("bounds the bitmap size for a large selection and rejects empty ink", async () => {
	const result = await page.evaluate(async () => {
		const image = new Image(); image.src = (window as any).renderInk({ traces: [[[0,0,0],[100000,50000,1]]] });
		await image.decode();
		let rejected = false; try { (window as any).renderInk({ traces: [] }); } catch { rejected = true; }
		return { width: image.width, height: image.height, rejected };
	});
	expect(result).toEqual({ width: 1600, height: 816, rejected: true });
});
