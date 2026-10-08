import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import process from "node:process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { LocalCodexService } from "./CodexDesktop";
import { FIGURE_FEEDBACK_MAX_CHARS, MAX_BODY_BYTES, UNPINNED_MODEL_LABEL } from "./CodexLimits";

const network = vi.hoisted(() => vi.fn());
vi.mock("obsidian", async original => ({ ...await original<object>(), requestUrl: network }));
const originalWindow = globalThis.window;
let folder: string;
let service: LocalCodexService | null;
let commands: string[][];
let port: number;
let settings: { url: string; token: string; model: string };
/** With this set, a spawned `codex exec` parks here instead of closing, so a
 * test can hold the single-flight slot and assert what frees it. */
let holdExec: boolean;
let heldExec: Array<EventEmitter & { kill: ReturnType<typeof vi.fn> }>;
/** What the fake `codex exec` writes as its answer. */
let execOutput: string;
/** The previous.svg sitting in the exec's working directory when it ran. */
let previousSvgOnDisk: string | null;

beforeEach(() => {
	folder = fs.mkdtempSync(path.join(os.tmpdir(), "handwriting-bridge-test-"));
	fs.writeFileSync(path.join(folder, "codex.exe"), "");
	fs.mkdirSync(path.join(folder, ".codex"));
	fs.writeFileSync(path.join(folder, ".codex", "config.toml"), 'model = "gpt-test"\n');
	commands = [];
	let signedIn = false;
	port = 19000 + Math.floor(Math.random() * 10000);
	settings = { url: `http://127.0.0.1:${port}`, token: "integration-token-at-least-24-characters", model: "" };
	service = null;
	const fakeProcess = { platform: "win32", env: { PATH: folder } };
	holdExec = false;
	heldExec = [];
	execOutput = "Text and $x^2$";
	previousSvgOnDisk = null;
	const child = {
		spawn: (_binary: string, args: string[], options?: { cwd?: string }) => {
			commands.push(args);
			const stdin = new PassThrough();
			const stdout = new PassThrough();
			// Like a real child, kill() leads to a `close` (code null on signal).
			const task: EventEmitter & { kill: ReturnType<typeof vi.fn>; stdin: PassThrough; stdout: PassThrough } =
				Object.assign(new EventEmitter(), { kill: vi.fn(() => queueMicrotask(() => task.emit("close", null))), stdin, stdout });
			if (args[0] === "app-server") stdin.on("data", (chunk: Buffer) => {
				const request = JSON.parse(chunk.toString("utf8"));
				if (request.id === 1) stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }) + "\n");
				if (request.method === "model/list") stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {
					data: [
						{ model: "gpt-image", displayName: "Image model", inputModalities: ["text", "image"] },
						{ model: "gpt-text", displayName: "Text model", inputModalities: ["text"] },
					], nextCursor: null,
				} }) + "\n");
			});
			queueMicrotask(() => {
				if (args[0] === "app-server") return;
				if (args[0] === "exec") {
					fs.writeFileSync(args[args.indexOf("--output-last-message") + 1]!, execOutput);
					// Captured here, before recognize()'s finally removes the dir.
					const previous = options?.cwd ? path.join(options.cwd, "previous.svg") : null;
					previousSvgOnDisk = previous && fs.existsSync(previous) ? fs.readFileSync(previous, "utf8") : null;
					if (holdExec) { heldExec.push(task); return; }
				}
				if (args[0] === "login" && args[1] !== "status") signedIn = true;
				task.emit("close", args[0] === "login" && args[1] === "status" && !signedIn ? 1 : 0);
			});
			return task;
		},
	};
	(globalThis as any).window = { require: (module: string) => ({
		"node:fs": fs, "node:os": { ...os, homedir: () => folder }, "node:path": path,
		"node:http": http, "node:crypto": crypto, "node:child_process": child, "node:process": fakeProcess,
	} as Record<string, unknown>)[module] };
	network.mockReset();
	network.mockImplementation(async ({ url, headers }: { url: string; headers: Record<string, string> }) => {
		const response = await fetch(url, { headers });
		return { status: response.status, json: await response.json() };
	});
});
afterEach(() => {
	service?.stop();
	fs.rmSync(folder, { recursive: true, force: true });
	(globalThis as any).window = originalWindow;
});

describe("desktop Codex bridge", () => {
	it("shares Codex login, hosts the iPad protocol, and keeps handwriting behind its token", async () => {
		service = new LocalCodexService(() => settings);
		await service.signIn();
		expect(commands.slice(0, 3)).toEqual([["login", "status"], ["login"], ["login", "status"]]);
		expect(await service.start()).toBe(settings.token);
		const base = `http://127.0.0.1:${port}`;
		const denied = await fetch(base + "/health");
		expect(denied.status).toBe(401);
		const headers = { Authorization: `Bearer ${settings.token}` };
		const health = await fetch(base + "/health", { headers });
		expect(await health.json()).toMatchObject({ provider: "codex", ready: true, model: "gpt-test" });
		const models = await fetch(base + "/models", { headers });
		expect(await models.json()).toEqual({ models: [{ id: "gpt-image", label: "Image model" }], defaultModel: "gpt-test" });
		const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9YlMP9kAAAAASUVORK5CYII=";
		const result = await fetch(base + "/recognize-note", { method: "POST", headers: { ...headers, "Content-Type": "application/json" },
			body: JSON.stringify({ images: ["data:image/png;base64," + png] }) });
		expect(result.status).toBe(200);
		expect(await result.json()).toEqual({ markdown: "Text and $x^2$", figures: [] });
		expect(commands.some(args => args[0] === "exec" && args.includes("--image") && args.at(-2) === "--" &&
			args.at(-1)?.startsWith("Transcribe the attached image(s)"))).toBe(true);
		expect(commands.find(args => args[0] === "exec")?.slice(-4, -2)).toEqual(["--model", "gpt-test"]);
		const override = await fetch(base + "/recognize-note", { method: "POST", headers: { ...headers, "Content-Type": "application/json" },
			body: JSON.stringify({ images: ["data:image/png;base64," + png], model: "gpt-choice" }) });
		expect(override.status).toBe(200);
		expect(commands.filter(args => args[0] === "exec").at(-1)?.slice(-4, -2)).toEqual(["--model", "gpt-choice"]);
		settings.model = "gpt-local-choice";
		const localChoice = await fetch(base + "/recognize-note", { method: "POST", headers: { ...headers, "Content-Type": "application/json" },
			body: JSON.stringify({ images: ["data:image/png;base64," + png] }) });
		expect(localChoice.status).toBe(200);
		expect(commands.filter(args => args[0] === "exec").at(-1)?.slice(-4, -2)).toEqual(["--model", "gpt-local-choice"]);
		settings.model = "";
		fs.rmSync(path.join(folder, ".codex", "config.toml"));
		const unpinned = await fetch(base + "/health", { headers });
		expect(await unpinned.json()).toMatchObject({ model: UNPINNED_MODEL_LABEL });
	});

	async function startedService(): Promise<{ base: string; headers: Record<string, string> }> {
		service = new LocalCodexService(() => settings);
		await service.signIn();
		await service.start();
		return { base: `http://127.0.0.1:${port}`, headers: { Authorization: `Bearer ${settings.token}`, "Content-Type": "application/json" } };
	}

	const PNG_PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9YlMP9kAAAAASUVORK5CYII=";

	async function untilHeldExec(count: number): Promise<void> {
		for (let i = 0; i < 200 && heldExec.length < count; i++) await new Promise(resolve => setTimeout(resolve, 5));
		expect(heldExec.length).toBe(count);
	}

	it("replies with a typed error instead of hanging when a request handler throws", async () => {
		// Before the handler-wide catch, /health with an invalid saved override
		// rejected inside the async handler: no reply, and the request sat open
		// until the CLIENT's timeout. The client's health clock is 10s, so a
		// hang here fails the suite by itself - but assert the shape anyway.
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const { base, headers } = await startedService();
			settings.model = "bad model";
			const health = await fetch(base + "/health", { headers });
			expect(health.status).toBe(500);
			expect(await health.json()).toEqual({ error: "Codex request failed." });
			expect(logged).toHaveBeenCalledWith("[handwriting] Codex bridge request failed", expect.any(Error));
		} finally { logged.mockRestore(); }
	});

	it("rejects an oversized request from its headers, before reading the body", async () => {
		const { base } = await startedService();
		const status = await new Promise<number>((resolve, reject) => {
			const request = http.request(`${base}/recognize-note`, { method: "POST", headers: {
				Authorization: `Bearer ${settings.token}`, "Content-Type": "application/json",
				"Content-Length": String(MAX_BODY_BYTES + 1),
			} }, response => { resolve(response.statusCode ?? 0); response.resume(); request.destroy(); });
			request.on("error", reject);
			request.write("{");
		});
		expect(status).toBe(413);
	});

	it("rejects images that are not PNGs or whose header promises too many pixels", async () => {
		const { base, headers } = await startedService();
		const notPng = Buffer.alloc(32, 7).toString("base64");
		const wrongMagic = await fetch(base + "/recognize-note", { method: "POST", headers,
			body: JSON.stringify({ images: [`data:image/png;base64,${notPng}`] }) });
		expect(wrongMagic.status).toBe(400);
		// A real PNG signature whose IHDR claims 3000x3000 - over the pixel cap
		// read straight from the header, no decode involved.
		const oversized = Buffer.alloc(32);
		Buffer.from("89504e470d0a1a0a", "hex").copy(oversized, 0);
		oversized.writeUInt32BE(3000, 16);
		oversized.writeUInt32BE(3000, 20);
		const tooBig = await fetch(base + "/recognize-note", { method: "POST", headers,
			body: JSON.stringify({ images: [`data:image/png;base64,${oversized.toString("base64")}`] }) });
		expect(tooBig.status).toBe(400);
		expect(commands.some(args => args[0] === "exec")).toBe(false);
	});

	it("serves one transcription at a time and cancel frees the slot by killing the exec", async () => {
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const { base, headers } = await startedService();
			holdExec = true;
			const held = fetch(base + "/recognize-note", { method: "POST", headers, body: JSON.stringify({ images: [PNG_PIXEL] }) });
			await untilHeldExec(1);
			const second = await fetch(base + "/recognize-note", { method: "POST", headers, body: JSON.stringify({ images: [PNG_PIXEL] }) });
			expect(second.status).toBe(429);
			const cancelled = await fetch(base + "/cancel", { method: "POST", headers });
			expect(await cancelled.json()).toEqual({ cancelled: true });
			expect(heldExec[0]!.kill).toHaveBeenCalled();
			// The killed exec surfaces as the held request's 500...
			expect((await held).status).toBe(500);
			// ...and the single-flight slot is actually free again.
			holdExec = false;
			const retry = await fetch(base + "/recognize-note", { method: "POST", headers, body: JSON.stringify({ images: [PNG_PIXEL] }) });
			expect(retry.status).toBe(200);
		} finally { logged.mockRestore(); }
	});

	it("stop kills the in-flight exec and drops its socket instead of orphaning both", async () => {
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const { base, headers } = await startedService();
			holdExec = true;
			const held = fetch(base + "/recognize-note", { method: "POST", headers, body: JSON.stringify({ images: [PNG_PIXEL] }) });
			await untilHeldExec(1);
			service!.stop();
			expect(heldExec[0]!.kill).toHaveBeenCalled();
			// The connection is destroyed rather than left to EXEC_TIMEOUT_MS.
			await expect(held.then(response => response.text())).rejects.toThrow();
		} finally { logged.mockRestore(); }
	});

	it("keeps /cancel behind the access token", async () => {
		const { base } = await startedService();
		const denied = await fetch(base + "/cancel", { method: "POST" });
		expect(denied.status).toBe(401);
	});

	it("parses the figures fence out of a transcription instead of leaking it to the client", async () => {
		const { base, headers } = await startedService();
		execOutput = 'Prose above the plot\n\n%%figure-1%%\n\n```figures\n[{"id":1,"box":[0.1,0.2,0.6,0.7]}]\n```';
		const result = await fetch(base + "/recognize-note", { method: "POST", headers,
			body: JSON.stringify({ images: [PNG_PIXEL] }) });
		expect(result.status).toBe(200);
		expect(await result.json()).toEqual({ markdown: "Prose above the plot\n\n%%figure-1%%",
			figures: [{ id: 1, box: { left: 0.1, top: 0.2, right: 0.6, bottom: 0.7 } }] });
	});

	it("redraws a figure with its own prompt, the feedback, and the previous SVG as a file", async () => {
		const { base, headers } = await startedService();
		// Fenced despite the instructions - the bridge unfences before validating.
		execOutput = '```svg\n<svg viewBox="0 0 10 10"><path d="M0 0 L10 10"/></svg>\n```';
		const result = await fetch(base + "/recognize-note", { method: "POST", headers, body: JSON.stringify({
			task: "redraw", images: [PNG_PIXEL], feedback: "make the axes thicker",
			previous: '<svg viewBox="0 0 1 1"/>' }) });
		expect(result.status).toBe(200);
		expect(await result.json()).toEqual({ svg: '<svg viewBox="0 0 10 10"><path d="M0 0 L10 10"/></svg>' });
		const prompt = commands.filter(args => args[0] === "exec").at(-1)!.at(-1)!;
		expect(prompt.startsWith("The attached image is one hand-drawn figure")).toBe(true);
		expect(prompt).toContain("make the axes thicker");
		// The previous SVG travels as a FILE, not argv: Windows caps a command
		// line at 32k characters and a figure can be most of that by itself.
		expect(prompt).toContain("previous.svg");
		expect(previousSvgOnDisk).toBe('<svg viewBox="0 0 1 1"/>');
	});

	it("rejects malformed redraw requests before any exec spawns", async () => {
		const { base, headers } = await startedService();
		const bodies = [
			{ task: "redraw", images: [PNG_PIXEL, PNG_PIXEL] },
			{ task: "redraw", images: [PNG_PIXEL], feedback: "x".repeat(FIGURE_FEEDBACK_MAX_CHARS + 1) },
			{ task: "transcribe-fancy", images: [PNG_PIXEL] },
		];
		for (const body of bodies) {
			const result = await fetch(base + "/recognize-note", { method: "POST", headers, body: JSON.stringify(body) });
			expect(result.status, JSON.stringify(body).slice(0, 64)).toBe(400);
		}
		expect(commands.some(args => args[0] === "exec")).toBe(false);
	});

	it("answers a typed 422 when the model breaks the figure contract", async () => {
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const { base, headers } = await startedService();
			// A marker with no declaration: dropping it would let replace-ink
			// delete the drawing, so the bridge fails the request instead.
			execOutput = "Prose\n\n%%figure-9%%";
			const result = await fetch(base + "/recognize-note", { method: "POST", headers,
				body: JSON.stringify({ images: [PNG_PIXEL] }) });
			expect(result.status).toBe(422);
			expect(((await result.json()) as { error: string }).error).toContain("did not declare");
		} finally { logged.mockRestore(); }
	});

	it("answers a typed 500 when the redraw is not SVG, instead of forwarding junk", async () => {
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const { base, headers } = await startedService();
			execOutput = "Sorry, I cannot draw that.";
			const result = await fetch(base + "/recognize-note", { method: "POST", headers,
				body: JSON.stringify({ task: "redraw", images: [PNG_PIXEL] }) });
			expect(result.status).toBe(500);
		} finally { logged.mockRestore(); }
	});
});
