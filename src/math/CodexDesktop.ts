/// <reference types="node" />
import { checkCodexNote, type CodexModelOption } from "./CodexService";

const PROMPT = `Transcribe the attached image(s) of handwritten notes into Obsidian Markdown.
If multiple images are attached, the first is an overview and the rest are
overlapping detail tiles in top-to-bottom, then left-to-right order. Use the
detail tiles to read small writing and the overview to understand layout.
Transcribe overlapping writing only once. Preserve all legible prose.
Write equations as valid LaTeX in $...$ or $$...$$. Preserve arrows and clear
relationships as symbols or concise labels, but do not invent relationships.
If a word or formula is uncertain, mark the uncertain part as [unclear] rather
than guessing. Do not describe the task, add a preface, or wrap the result in a
code fence. Do not use tools or access any files beyond the attached image.
Return only the Markdown transcription.`;
const PNG_PREFIX = "data:image/png;base64,";
const MAX_BODY = 12 * 1024 * 1024;

function desktopNode() {
	const host = window as Window & { require?: (module: string) => unknown };
	if (typeof host.require !== "function") throw new Error("Codex hosting requires desktop Obsidian.");
	return {
		fs: host.require("node:fs") as typeof import("node:fs"),
		path: host.require("node:path") as typeof import("node:path"),
		os: host.require("node:os") as typeof import("node:os"),
		crypto: host.require("node:crypto") as typeof import("node:crypto"),
		http: host.require("node:http") as typeof import("node:http"),
		child: host.require("node:child_process") as typeof import("node:child_process"),
		process: host.require("node:process") as typeof import("node:process"),
	};
}

export interface LocalCodexSettings { url: string; token: string; model: string }

export class LocalCodexService {
	private server: import("node:http").Server | null = null;
	private serverToken: string | null = null;
	private pending: Promise<string> | null = null;
	private stopped = false;
	private active = false;
	private modelPending: Promise<CodexModelOption[]> | null = null;
	constructor(private settings: () => LocalCodexSettings) {}

	private binary(): string {
		const { fs, path, os, process } = desktopNode();
		const exe = process.platform === "win32" ? "codex.exe" : "codex";
		const paths = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map(dir => path.join(dir, exe));
		if (process.platform === "win32") {
			const releases = path.join(os.homedir(), ".codex", "packages", "standalone", "releases");
			if (fs.existsSync(releases)) {
				paths.push(...fs.readdirSync(releases).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
					.map(name => path.join(releases, name, "bin", "codex.exe")));
			}
			if (process.env.APPDATA) paths.push(path.join(process.env.APPDATA, "npm", "node_modules", "@openai", "codex",
				"vendor", "x86_64-pc-windows-msvc", "codex", "codex.exe"));
		}
		const found = paths.find(candidate => fs.existsSync(candidate));
		if (!found) throw new Error("Install Codex CLI on this laptop and sign in with ChatGPT.");
		return found;
	}

	private run(binary: string, args: string[], timeout: number, cwd?: string): Promise<number> {
		const { child, process } = desktopNode();
		return new Promise((resolve, reject) => {
			const task = child.spawn(binary, args, { cwd, windowsHide: true, stdio: "ignore", env: { ...process.env } });
			const timer = setTimeout(() => { task.kill(); reject(new Error("Codex timed out.")); }, timeout);
			task.once("error", error => { clearTimeout(timer); reject(error); });
			task.once("close", code => { clearTimeout(timer); resolve(code ?? 1); });
		});
	}

	private listModels(binary: string): Promise<CodexModelOption[]> {
		return this.modelPending ??= this.queryModels(binary).finally(() => { this.modelPending = null; });
	}

	private queryModels(binary: string): Promise<CodexModelOption[]> {
		const { child, process } = desktopNode();
		return new Promise((resolve, reject) => {
			const task = child.spawn(binary, ["app-server", "--listen", "stdio://"], {
				windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env },
			});
			let finished = false;
			let buffer = "";
			let requestId = 1;
			const models = new Map<string, CodexModelOption>();
			const cursors = new Set<string>();
			const finish = (error?: Error) => {
				if (finished) return;
				finished = true;
				clearTimeout(timer);
				task.kill();
				if (error) reject(error);
				else resolve([...models.values()]);
			};
			const send = (value: Record<string, unknown>) => task.stdin.write(JSON.stringify(value) + "\n");
			const page = (cursor?: string) => {
				requestId++;
				send({ jsonrpc: "2.0", id: requestId, method: "model/list",
					params: { includeHidden: false, limit: 100, ...(cursor ? { cursor } : {}) } });
			};
			const timer = setTimeout(() => finish(new Error("Codex model discovery timed out.")), 15_000);
			task.once("error", () => finish(new Error("Could not start Codex model discovery.")));
			task.once("close", () => finish(new Error("Codex model discovery stopped unexpectedly.")));
			task.stdout.on("data", (chunk: Buffer) => {
				buffer += chunk.toString("utf8");
				if (buffer.length > 2_000_000) return finish(new Error("Codex model list is too large."));
				let newline: number;
				while ((newline = buffer.indexOf("\n")) >= 0 && !finished) {
					const line = buffer.slice(0, newline).trim();
					buffer = buffer.slice(newline + 1);
					if (!line) continue;
					let message: { id?: number; result?: { data?: unknown[]; nextCursor?: unknown }; error?: { message?: string } };
					try { message = JSON.parse(line); } catch { continue; }
					if (message.id !== requestId) continue;
					if (message.error) return finish(new Error(message.error.message || "Codex model discovery failed."));
					if (requestId === 1) {
						send({ jsonrpc: "2.0", method: "initialized" });
						page();
						continue;
					}
					if (!Array.isArray(message.result?.data)) return finish(new Error("Codex returned an invalid model list."));
					for (const entry of message.result.data) {
						if (!entry || typeof entry !== "object") continue;
						const item = entry as { id?: unknown; model?: unknown; displayName?: unknown; hidden?: unknown; inputModalities?: unknown };
						const id = typeof item.model === "string" ? item.model : item.id;
						if (typeof id !== "string" || !/^[A-Za-z0-9._-]+$/.test(id) || item.hidden === true) continue;
						if (Array.isArray(item.inputModalities) && !item.inputModalities.includes("image")) continue;
						models.set(id, { id, label: typeof item.displayName === "string" && item.displayName.trim() ? item.displayName : id });
					}
					const cursor = message.result.nextCursor;
					if (typeof cursor === "string" && cursor) {
						if (cursors.has(cursor)) return finish(new Error("Codex repeated a model list page."));
						cursors.add(cursor);
						page(cursor);
					} else finish();
				}
			});
			send({ jsonrpc: "2.0", id: 1, method: "initialize",
				params: { clientInfo: { name: "handwriting", title: "Handwriting", version: "1.0.0" }, capabilities: {} } });
		});
	}

	modelSelection(requestedModel = ""): { model: string; source: string } {
		const override = requestedModel.trim() || this.settings().model.trim();
		if (override) {
			if (!/^[A-Za-z0-9._-]+$/.test(override)) throw new Error("Use a Codex model ID containing only letters, numbers, dots, hyphens, or underscores.");
			return { model: override, source: "Handwriting override" };
		}
		const { fs, path, os } = desktopNode();
		try {
			const config = fs.readFileSync(path.join(os.homedir(), ".codex", "config.toml"), "utf8");
			const topLevel = config.split(/^\s*\[[^\]]+\]\s*$/m, 1)[0] ?? "";
			const model = /^model\s*=\s*["']([A-Za-z0-9._-]+)["']/m.exec(topLevel)?.[1];
			if (model) return { model, source: "laptop Codex config" };
		} catch { /* Codex can still choose its built-in default. */ }
		return { model: "Codex CLI default (not pinned)", source: "Codex CLI" };
	}

	private async recognize(binary: string, images: string[], requestedModel = ""): Promise<string> {
		const { fs, os, path } = desktopNode();
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "handwriting-codex-"));
		try {
			const output = path.join(dir, "transcription.md");
			const args = ["exec", "--sandbox", "read-only", "--ephemeral", "--skip-git-repo-check",
				"--ignore-user-config", "-C", dir, "--output-last-message", output];
			for (const [index, image] of images.entries()) {
				const file = path.join(dir, `handwriting-${index + 1}.png`);
				await fs.promises.writeFile(file, Buffer.from(image.slice(PNG_PREFIX.length), "base64"));
				args.push("--image", file);
			}
			const { model } = this.modelSelection(requestedModel);
			if (model !== "Codex CLI default (not pinned)") args.push("--model", model);
			args.push("--", PROMPT);
			if (await this.run(binary, args, 240_000, dir) !== 0) throw new Error("Codex failed.");
			const markdown = (await fs.promises.readFile(output, "utf8")).trim();
			if (!markdown || markdown.length > 100_000) throw new Error("Invalid transcription.");
			return markdown;
		} finally { await fs.promises.rm(dir, { recursive: true, force: true }); }
	}

	start(): Promise<string> {
		return this.pending ??= this.startOnce().finally(() => { this.pending = null; });
	}

	private async startOnce(): Promise<string> {
		if (this.stopped) throw new Error("Codex service startup was cancelled.");
		const { crypto, http } = desktopNode();
		const binary = this.binary();
		if (await this.run(binary, ["login", "status"], 10_000) !== 0) {
			throw new Error("Sign in to Codex with ChatGPT on this laptop, then try again.");
		}
		const url = new URL(this.settings().url);
		if (url.protocol !== "http:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
			throw new Error("Set a plain HTTP laptop service URL without a path or query.");
		}
		const port = Number(url.port || "8765");
		const token = this.settings().token.trim().length >= 24 ? this.settings().token.trim() : crypto.randomBytes(32).toString("base64url");
		if (this.server) return this.serverToken!;
		try { await checkCodexNote({ url: `http://127.0.0.1:${port}`, token }); return token; }
		catch { /* No compatible local server is running. */ }
		const server = http.createServer(async (req, res) => {
			const reply = (status: number, value: Record<string, unknown>) => {
				res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
				res.end(JSON.stringify(value));
			};
			if (req.headers.authorization !== `Bearer ${token}`) return reply(401, { error: "Invalid access token." });
			if (req.method === "GET" && req.url === "/health") return reply(200, { provider: "codex", ready: true, ...this.modelSelection() });
			if (req.method === "GET" && req.url === "/models") {
				try { return reply(200, { models: await this.listModels(binary), defaultModel: this.modelSelection().model }); }
				catch { return reply(503, { error: "Codex model list unavailable. Check the laptop's Codex CLI." }); }
			}
			if (req.method !== "POST" || req.url !== "/recognize-note") return reply(404, { error: "Unknown endpoint." });
			if (this.active) return reply(429, { error: "Recognition already running." });
			const length = Number(req.headers["content-length"] ?? 0);
			if (!Number.isInteger(length) || length < 1 || length > MAX_BODY) return reply(413, { error: "Invalid request size." });
			this.active = true;
			try {
				const chunks: Buffer[] = [];
				let size = 0;
				for await (const chunk of req) {
					size += chunk.length;
					if (size > MAX_BODY) throw new Error("Request too large.");
					chunks.push(chunk);
				}
				const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
				const images = (body as { images?: unknown })?.images;
				const requestedModel = (body as { model?: unknown })?.model;
				if (requestedModel !== undefined && (typeof requestedModel !== "string" ||
					(requestedModel && !/^[A-Za-z0-9._-]+$/.test(requestedModel)))) {
					return reply(400, { error: "Invalid Codex model ID." });
				}
				if (!Array.isArray(images) || images.length < 1 || images.length > 9 ||
					images.some(image => typeof image !== "string" || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(image))) {
					return reply(400, { error: "Expected one to nine PNG images." });
				}
				for (const image of images as string[]) {
					const png = Buffer.from(image.slice(PNG_PREFIX.length), "base64");
					if (png.length < 24 || png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
						png.readUInt32BE(16) * png.readUInt32BE(20) > 8_000_000) {
						return reply(400, { error: "Invalid or oversized PNG image." });
					}
				}
				reply(200, { markdown: await this.recognize(binary, images as string[], requestedModel as string | undefined) });
			} catch { reply(500, { error: "Codex recognition failed. Check sign-in and model access." }); }
			finally { this.active = false; }
		});
		try {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(port, "0.0.0.0", () => { server.off("error", reject); resolve(); });
			});
			this.server = server;
			this.serverToken = token;
			return token;
		} catch (error) { server.close(); throw error; }
	}

	async signIn(): Promise<void> {
		const binary = this.binary();
		if (await this.run(binary, ["login", "status"], 10_000) === 0) return;
		if (await this.run(binary, ["login"], 300_000) !== 0) throw new Error("Codex sign-in did not complete.");
		if (await this.run(binary, ["login", "status"], 10_000) !== 0) throw new Error("Codex sign-in could not be verified.");
	}

	stop(): void {
		this.stopped = true;
		this.server?.close();
		this.server = null;
		this.serverToken = null;
	}
}
