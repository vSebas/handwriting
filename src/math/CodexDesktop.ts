/// <reference types="node" />
import { checkCodexNote, type CodexModelOption } from "./CodexService";
import {
	EXEC_TIMEOUT_MS, LOGIN_STATUS_TIMEOUT_MS, LOGIN_TIMEOUT_MS, MAX_BODY_BYTES, MAX_IMAGES,
	MAX_IMAGE_PIXELS, MAX_TRANSCRIPTION_CHARS, MODEL_LIST_MAX_CHARS, MODEL_LIST_TIMEOUT_MS,
	UNPINNED_MODEL_LABEL,
} from "./CodexLimits";

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
	/** Every child this service spawned and has not yet seen exit, so stop()
	 * can kill them instead of leaving a four-minute `codex exec` orphaned. */
	private children = new Set<import("node:child_process").ChildProcess>();
	/** Kills the `codex exec` currently answering /recognize-note, if any.
	 * POST /cancel calls it: the killed child exits non-zero, the hanging
	 * request replies 500, and its `finally` frees the single-flight slot. */
	private cancelExec: (() => void) | null = null;
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

	private run(binary: string, args: string[], timeout: number, cwd?: string, onSpawn?: (kill: () => void) => void): Promise<number> {
		const { child, process } = desktopNode();
		return new Promise((resolve, reject) => {
			const task = child.spawn(binary, args, { cwd, windowsHide: true, stdio: "ignore", env: { ...process.env } });
			this.children.add(task);
			const timer = setTimeout(() => { task.kill(); reject(new Error("Codex timed out.")); }, timeout);
			task.once("error", error => { clearTimeout(timer); this.children.delete(task); reject(error); });
			task.once("close", code => { clearTimeout(timer); this.children.delete(task); resolve(code ?? 1); });
			onSpawn?.(() => task.kill());
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
			this.children.add(task);
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
				this.children.delete(task);
				if (error) reject(error);
				else resolve([...models.values()]);
			};
			const send = (value: Record<string, unknown>) => task.stdin.write(JSON.stringify(value) + "\n");
			const page = (cursor?: string) => {
				requestId++;
				send({ jsonrpc: "2.0", id: requestId, method: "model/list",
					params: { includeHidden: false, limit: 100, ...(cursor ? { cursor } : {}) } });
			};
			const timer = setTimeout(() => finish(new Error("Codex model discovery timed out.")), MODEL_LIST_TIMEOUT_MS);
			task.once("error", () => finish(new Error("Could not start Codex model discovery.")));
			task.once("close", () => finish(new Error("Codex model discovery stopped unexpectedly.")));
			task.stdout.on("data", (chunk: Buffer) => {
				buffer += chunk.toString("utf8");
				if (buffer.length > MODEL_LIST_MAX_CHARS) return finish(new Error("Codex model list is too large."));
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

	/** `model: null` means unpinned - Codex CLI chooses. Serialization edges
	 * render it as UNPINNED_MODEL_LABEL; nothing compares against the label. */
	modelSelection(requestedModel = ""): { model: string | null; source: string } {
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
		return { model: null, source: "Codex CLI" };
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
			if (model) args.push("--model", model);
			args.push("--", PROMPT);
			const code = await this.run(binary, args, EXEC_TIMEOUT_MS, dir, kill => { this.cancelExec = kill; });
			if (code !== 0) throw new Error("Codex failed.");
			const markdown = (await fs.promises.readFile(output, "utf8")).trim();
			if (!markdown || markdown.length > MAX_TRANSCRIPTION_CHARS) throw new Error("Invalid transcription.");
			return markdown;
		} finally {
			this.cancelExec = null;
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	}

	start(): Promise<string> {
		return this.pending ??= this.startOnce().finally(() => { this.pending = null; });
	}

	private async startOnce(): Promise<string> {
		if (this.stopped) throw new Error("Codex service startup was cancelled.");
		const { crypto, http } = desktopNode();
		const binary = this.binary();
		if (await this.run(binary, ["login", "status"], LOGIN_STATUS_TIMEOUT_MS) !== 0) {
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
			// Nothing may throw past this frame: an async handler's uncaught
			// rejection sends no reply at all, and the request hangs until the
			// client's timeout. /health's modelSelection() did exactly that
			// when the saved override failed the model-ID check.
			try {
				if (req.headers.authorization !== `Bearer ${token}`) return reply(401, { error: "Invalid access token." });
				if (req.method === "GET" && req.url === "/health") {
					const selection = this.modelSelection();
					return reply(200, { provider: "codex", ready: true, ...selection, model: selection.model ?? UNPINNED_MODEL_LABEL });
				}
				if (req.method === "GET" && req.url === "/models") {
					try { return reply(200, { models: await this.listModels(binary), defaultModel: this.modelSelection().model ?? UNPINNED_MODEL_LABEL }); }
					catch { return reply(503, { error: "Codex model list unavailable. Check the laptop's Codex CLI." }); }
				}
				// The iPad's requestUrl cannot abort a request it has sent, so a
				// cancelled modal frees only its UI; this is how it frees the
				// laptop. Killing the exec makes the in-flight /recognize-note
				// reply 500 (to a client no longer listening) and release the
				// single-flight slot, instead of blocking retries for minutes.
				if (req.method === "POST" && req.url === "/cancel") {
					this.cancelExec?.();
					return reply(200, { cancelled: this.active });
				}
				if (req.method !== "POST" || req.url !== "/recognize-note") return reply(404, { error: "Unknown endpoint." });
				if (this.active) return reply(429, { error: "Recognition already running." });
				const length = Number(req.headers["content-length"] ?? 0);
				if (!Number.isInteger(length) || length < 1 || length > MAX_BODY_BYTES) return reply(413, { error: "Invalid request size." });
				this.active = true;
				try {
					const chunks: Buffer[] = [];
					let size = 0;
					for await (const chunk of req) {
						size += chunk.length;
						if (size > MAX_BODY_BYTES) throw new Error("Request too large.");
						chunks.push(chunk);
					}
					const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
					const images = (body as { images?: unknown })?.images;
					const requestedModel = (body as { model?: unknown })?.model;
					if (requestedModel !== undefined && (typeof requestedModel !== "string" ||
						(requestedModel && !/^[A-Za-z0-9._-]+$/.test(requestedModel)))) {
						return reply(400, { error: "Invalid Codex model ID." });
					}
					if (!Array.isArray(images) || images.length < 1 || images.length > MAX_IMAGES ||
						images.some(image => typeof image !== "string" || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(image))) {
						return reply(400, { error: "Expected one to nine PNG images." });
					}
					for (const image of images as string[]) {
						const png = Buffer.from(image.slice(PNG_PREFIX.length), "base64");
						if (png.length < 24 || png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
							png.readUInt32BE(16) * png.readUInt32BE(20) > MAX_IMAGE_PIXELS) {
							return reply(400, { error: "Invalid or oversized PNG image." });
						}
					}
					reply(200, { markdown: await this.recognize(binary, images as string[], requestedModel as string | undefined) });
				} catch (error) {
					// The wire gets the generic sentence; the real cause goes to
					// the console, or a failed transcription is undebuggable.
					console.error("[handwriting] Codex recognition failed", error);
					reply(500, { error: "Codex recognition failed. Check sign-in and model access." });
				}
				finally { this.active = false; }
			} catch (error) {
				console.error("[handwriting] Codex bridge request failed", error);
				if (!res.headersSent) reply(500, { error: "Codex request failed." });
				else res.end();
			}
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
		if (await this.run(binary, ["login", "status"], LOGIN_STATUS_TIMEOUT_MS) === 0) return;
		if (await this.run(binary, ["login"], LOGIN_TIMEOUT_MS) !== 0) throw new Error("Codex sign-in did not complete.");
		if (await this.run(binary, ["login", "status"], LOGIN_STATUS_TIMEOUT_MS) !== 0) throw new Error("Codex sign-in could not be verified.");
	}

	stop(): void {
		this.stopped = true;
		// Children first: an orphaned `codex exec` would otherwise keep working
		// (and holding the GPU/account slot) for up to EXEC_TIMEOUT_MS after
		// the plugin unloaded. Killing them also unblocks any request handler
		// awaiting run(), so the server can actually finish closing.
		for (const task of this.children) task.kill();
		this.children.clear();
		// close() alone waits for in-flight requests that will now never
		// finish; closeAllConnections (Node >= 18.2, Obsidian ships Node 20)
		// drops their sockets too.
		this.server?.closeAllConnections?.();
		this.server?.close();
		this.server = null;
		this.serverToken = null;
	}
}
