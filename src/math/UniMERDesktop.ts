import { checkUniMERNet } from "./UniMERNet";
import { timerHost } from "../util/RuntimeScheduler";

interface ServiceChild {
	exitCode: number | null;
	on(event: "error", listener: (error: Error) => void): void;
	kill(): boolean;
}

/** Node is obtained only after the caller has established a desktop Obsidian host. */
function node() {
	const host = window as Window & { require?: (module: string) => unknown };
	if (typeof host.require !== "function") throw new Error("Desktop service control is unavailable in this Obsidian window.");
	return {
		fs: host.require("node:fs") as {
			existsSync(path: string): boolean;
			readFileSync(path: string, encoding: "utf8"): string;
			writeFileSync(path: string, data: string, options: { encoding: "utf8"; flag: "wx"; mode: number }): void;
		},
		path: host.require("node:path") as { join(...parts: string[]): string; resolve(path: string): string },
		os: host.require("node:os") as { homedir(): string },
		crypto: host.require("node:crypto") as { randomBytes(size: number): { toString(encoding: "base64url"): string } },
		childProcess: host.require("node:child_process") as { spawn(command: string, args: string[], options: {
			cwd: string; windowsHide: boolean; stdio: "ignore"; env: Record<string, string | undefined>;
		}): ServiceChild },
		process: host.require("node:process") as { env: Record<string, string | undefined> },
	};
}

export interface LocalUniMERSettings { root: string; url: string; token: string }

export class LocalUniMERService {
	private child: ServiceChild | null = null;
	private pending: Promise<string> | null = null;
	private stopped = false;

	constructor(private settings: () => LocalUniMERSettings) {}

	root(): string {
		const { path, os } = node();
		return path.resolve(this.settings().root.trim() || path.join(os.homedir(), "Documents", "handwriting"));
	}

	installed(): boolean {
		const { fs, path } = node();
		const root = this.root();
		return fs.existsSync(path.join(root, ".tools", "unimer-venv", "Scripts", "python.exe"))
			&& fs.existsSync(path.join(root, "services", "unimernet", "server.py"))
			&& fs.existsSync(path.join(root, ".tools", "unimernet-base", "pytorch_model.pth"));
	}

	start(): Promise<string> {
		if (this.pending) return this.pending;
		this.pending = this.startOnce().finally(() => { this.pending = null; });
		return this.pending;
	}

	private async startOnce(): Promise<string> {
		if (this.stopped) throw new Error("UniMERNet startup was cancelled.");
		if (!this.installed()) throw new Error("UniMERNet is not installed at the configured service folder. See the UniMERNet setup instructions.");
		const { fs, path, crypto, childProcess, process } = node();
		const root = this.root();
		const tokenPath = path.join(root, ".tools", "unimernet-access-token.txt");
		let token: string;
		if (fs.existsSync(tokenPath)) {
			token = fs.readFileSync(tokenPath, "utf8").trim();
		} else {
			const configured = this.settings().token.trim();
			token = configured.length >= 24 ? configured : crypto.randomBytes(32).toString("base64url");
			try { fs.writeFileSync(tokenPath, token, { encoding: "utf8", flag: "wx", mode: 0o600 }); }
			catch (error) {
				if ((error as { code?: string }).code !== "EEXIST") throw error;
				token = fs.readFileSync(tokenPath, "utf8").trim();
			}
		}
		if (token.length < 24) throw new Error("The UniMERNet access-token file is invalid. Replace it with a token of at least 24 characters.");
		const configuredUrl = new URL(this.settings().url);
		if (configuredUrl.protocol !== "http:" || configuredUrl.username || configuredUrl.password || configuredUrl.pathname !== "/" || configuredUrl.search || configuredUrl.hash) {
			throw new Error("For automatic startup, set a plain HTTP UniMERNet service URL without a path or query.");
		}
		const port = configuredUrl.port || "8765";
		const local = { url: `http://127.0.0.1:${port}`, token };
		try { await checkUniMERNet(local); return token; }
		catch { /* Start the service if nothing answering on this port has our token. */ }
		if (this.stopped) throw new Error("UniMERNet startup was cancelled.");
		const python = path.join(root, ".tools", "unimer-venv", "Scripts", "python.exe");
		const script = path.join(root, "services", "unimernet", "server.py");
		const model = path.join(root, ".tools", "unimernet-base");
		const child = childProcess.spawn(python, [script, "--host", "0.0.0.0", "--port", port,
			"--model-dir", model, "--token-file", tokenPath], {
			cwd: root, windowsHide: true, stdio: "ignore",
			env: { ...process.env, HF_HOME: path.join(root, ".tools", "hf-cache"), HF_HUB_DISABLE_TELEMETRY: "1" },
		});
		this.child = child;
		let launchError: Error | undefined;
		child.on("error", error => { launchError = error; });
		try {
			const deadline = Date.now() + 120_000;
			while (Date.now() < deadline) {
				if (this.stopped) throw new Error("UniMERNet startup was cancelled.");
				if (launchError || child.exitCode !== null) {
					throw new Error("UniMERNet exited during startup. Check the service folder, Python environment, and port.");
				}
				try { await checkUniMERNet(local); return token; }
				catch { await new Promise<void>(resolve => timerHost().setTimeout(resolve, 700)); }
			}
			throw new Error("UniMERNet did not become ready within two minutes. Check the service installation.");
		} catch (error) {
			child.kill();
			if (this.child === child) this.child = null;
			throw error;
		}
	}

	stop(): void {
		this.stopped = true;
		this.child?.kill();
		this.child = null;
	}
}
