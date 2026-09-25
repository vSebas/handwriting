import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { chromium } from "playwright";

// Run explicitly with the downloaded models: node scripts/test-math-model.mjs <model-directory>
// Tests actual WASM inference offline; no network, paid API, or recognition mock.
const directory = resolve(process.argv[2] || ".tools/htt");
const models = {};
for (const [key, file, hash] of [
	["encoder", "encoder.onnx", "2b56c120cd5b760637572fc5c35012dcf14c7e923ca3362d54fdd54ddc6ef719"],
	["decoder", "decoder_step.onnx", "a06a382a4b21445e0ef4d5ba33db4dc4eb9250ca4ff4bace7a90d50342ef18ed"],
]) {
	const bytes = readFileSync(resolve(directory, file));
	if (createHash("sha256").update(bytes).digest("hex") !== hash) throw new Error(`Invalid model: ${file}`);
	models[key] = bytes.toString("base64");
}
const bundle = await build({ entryPoints: ["src/math/HandToTexWorker.ts"], bundle: true, write: false,
	minify: true, platform: "browser", format: "iife", target: "es2022",
	loader: { ".wasm": "binary" }, define: { "import.meta.url": "self.location.href" } });
let time = 0;
const line = (x0, y0, x1, y1) => Array.from({ length: 20 }, (_, i) => [x0 + (x1 - x0) * i / 19, y0 + (y1 - y0) * i / 19, time += 10]);
const traces = [line(0, 0, 0, 30), line(20, 15, 40, 15), line(30, 5, 30, 25), line(60, 0, 60, 30)];
const browser = await chromium.launch({ headless: true });
try {
	const page = await browser.newPage();
	const requests = [];
	await page.route("**/*", route => { requests.push(route.request().url()); return route.abort(); });
	const result = await page.evaluate(async ({ source, models, traces }) => {
		const decode = value => Uint8Array.from(atob(value), ch => ch.charCodeAt(0)).buffer;
		const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
		const worker = new Worker(url);
		const started = performance.now();
		try {
			return await new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("Model smoke test timed out")), 120_000);
				worker.onerror = event => { clearTimeout(timer); reject(new Error(event.message)); };
				worker.onmessage = event => {
					if (event.data.progress) return;
					clearTimeout(timer);
					if (event.data.error) reject(new Error(event.data.error));
					else resolve({ latex: event.data.latex, candidates: event.data.candidates, elapsedMs: Math.round(performance.now() - started) });
				};
				worker.postMessage({ ink: { traces }, encoder: decode(models.encoder), decoder: decode(models.decoder) });
			});
		} finally { worker.terminate(); URL.revokeObjectURL(url); }
	}, { source: bundle.outputFiles[0].text, models, traces });
	if (requests.length) throw new Error(`Inference attempted external requests: ${requests.join(", ")}`);
	if (result.latex.replace(/\s/g, "") !== "1+1") throw new Error(`Unexpected recognition: ${result.latex}`);
	if (!Array.isArray(result.candidates) || result.candidates.length < 2 || result.candidates.length > 3
		|| result.candidates[0] !== result.latex || new Set(result.candidates).size !== result.candidates.length) {
		throw new Error(`Expected distinct ranked alternatives: ${JSON.stringify(result.candidates)}`);
	}
	console.log(JSON.stringify({ ...result, externalRequests: requests.length }));
} finally { await browser.close(); }
