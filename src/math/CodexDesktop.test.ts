import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import process from "node:process";
import { EventEmitter } from "node:events";
import { LocalCodexService } from "./CodexDesktop";

const network = vi.hoisted(() => vi.fn());
vi.mock("obsidian", async original => ({ ...await original<object>(), requestUrl: network }));
const originalWindow = globalThis.window;
let folder: string;
let service: LocalCodexService | null;
let commands: string[][];
let port: number;
let settings: { url: string; token: string; model: string };

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
	const child = {
		spawn: (_binary: string, args: string[]) => {
			commands.push(args);
			const task = Object.assign(new EventEmitter(), { kill: vi.fn() });
			queueMicrotask(() => {
				if (args[0] === "exec") fs.writeFileSync(args[args.indexOf("--output-last-message") + 1]!, "Text and $x^2$");
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
		const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9YlMP9kAAAAASUVORK5CYII=";
		const result = await fetch(base + "/recognize-note", { method: "POST", headers: { ...headers, "Content-Type": "application/json" },
			body: JSON.stringify({ images: ["data:image/png;base64," + png] }) });
		expect(result.status).toBe(200);
		expect(await result.json()).toEqual({ markdown: "Text and $x^2$" });
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
		expect(await unpinned.json()).toMatchObject({ model: "Codex CLI default (not pinned)" });
	});
});
