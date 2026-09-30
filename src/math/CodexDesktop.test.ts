import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { LocalCodexService } from "./CodexDesktop";

const network = vi.hoisted(() => vi.fn());
vi.mock("obsidian", async original => ({ ...await original<object>(), requestUrl: network }));
const originalWindow = globalThis.window;
const files = new Map<string, string>();
const fakeHome = path.resolve("test", "fake-home");
const processChild = { exitCode: null as number | null, killed: false, on: vi.fn(), kill: vi.fn(function () { processChild.killed = true; return true; }) };
const spawn = vi.fn((_command: string, _args: string[], _options: Record<string, unknown>) => processChild);
const settings = { root: "", url: "http://192.168.1.20:8765", token: "" };

beforeEach(() => {
	settings.root = "";
	files.clear(); network.mockReset(); spawn.mockClear(); processChild.exitCode = null; processChild.killed = false; processChild.kill.mockClear();
	(globalThis as any).window = { setTimeout, clearTimeout, require: (module: string) => ({
		"node:fs": { existsSync: (name: string) => name.endsWith("codex-access-token.txt") ? files.has(name) : true,
			readFileSync: (name: string) => files.get(name), writeFileSync: (name: string, value: string) => { files.set(name, value); } },
		"node:path": path, "node:os": { homedir: () => fakeHome },
		"node:crypto": { randomBytes: () => ({ toString: () => "generated-token-at-least-24-characters" }) },
		"node:child_process": { spawn }, "node:process": { env: {} },
	})[module] };
});
afterEach(() => { (globalThis as any).window = originalWindow; });

describe("desktop Codex service lifecycle", () => {
	it("resolves the default from this computer's home and accepts another service folder", () => {
		const service = new LocalCodexService(() => settings);
		expect(service.root()).toBe(path.join(fakeHome, "Documents", "handwriting"));
		settings.root = path.resolve("test", "another-installation");
		expect(service.root()).toBe(settings.root);
	});
	it("starts the installed model once, binds for the iPad, and stops its own child", async () => {
		network.mockRejectedValueOnce(new Error("not running"));
		network.mockResolvedValue({ status: 200, json: { provider: "codex", ready: true, model: "gpt-test" } });
		const service = new LocalCodexService(() => settings);
		const [first, second] = await Promise.all([service.start(), service.start()]);
		expect(first).toBe("generated-token-at-least-24-characters");
		expect(second).toBe(first);
		expect(spawn).toHaveBeenCalledTimes(1);
		const [executable, args, options] = spawn.mock.calls[0]!;
		expect(executable).toContain("codex-venv");
		expect(args).toEqual(expect.arrayContaining(["--host", "0.0.0.0", "--port", "8765"]));
		expect(options).toMatchObject({ windowsHide: true, stdio: "ignore" });
		expect(network.mock.calls.every(([request]) => request.url === "http://127.0.0.1:8765/health")).toBe(true);
		expect(Array.from(files.values())).toEqual([first]);
		service.stop();
		expect(processChild.kill).toHaveBeenCalledTimes(1);
	});
	it("reuses a running service and its existing token without taking ownership", async () => {
		files.set(path.join(fakeHome, "Documents", "handwriting", ".tools", "codex-access-token.txt"), "existing-token-at-least-24-characters");
		network.mockResolvedValue({ status: 200, json: { provider: "codex", ready: true, model: "gpt-test" } });
		const service = new LocalCodexService(() => settings);
		expect(await service.start()).toBe("existing-token-at-least-24-characters");
		service.stop();
		expect(spawn).not.toHaveBeenCalled();
		expect(processChild.kill).not.toHaveBeenCalled();
	});
	it("reports an exited service and cleans up the failed launch", async () => {
		network.mockRejectedValue(new Error("not running"));
		processChild.exitCode = 1;
		const service = new LocalCodexService(() => settings);
		await expect(service.start()).rejects.toThrow("exited during startup");
		expect(processChild.kill).toHaveBeenCalledTimes(1);
	});
});
