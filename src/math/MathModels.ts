import { requestUrl, normalizePath, type DataAdapter } from "obsidian";
import { sha256 } from "../pdf/Sha256";

export const MODEL_REVISION = "58170cc16748a5652e5e58caf93019fb8b0603c4";
export const MATH_MODELS = [
	{ name: "encoder.onnx", size: 11269588, sha256: "2b56c120cd5b760637572fc5c35012dcf14c7e923ca3362d54fdd54ddc6ef719" },
	{ name: "decoder_step.onnx", size: 7241361, sha256: "a06a382a4b21445e0ef4d5ba33db4dc4eb9250ca4ff4bace7a90d50342ef18ed" },
] as const;

export function verifyMathModel(data: ArrayBuffer, model: typeof MATH_MODELS[number]): void {
	if (data.byteLength !== model.size) throw new Error(`Incomplete ${model.name}. Download the recognition model again in Handwriting settings.`);
	const hash = Array.from(sha256(new Uint8Array(data)), b => b.toString(16).padStart(2, "0")).join("");
	if (hash !== model.sha256) throw new Error(`Invalid ${model.name}. Download the recognition model again in Handwriting settings.`);
}

export class MathModels {
	private downloading: Promise<void> | null = null;
	constructor(private adapter: Pick<DataAdapter, "readBinary" | "writeBinary" | "exists" | "mkdir" | "list" | "remove">, private pluginDir: string) {}
	private folder(): string { return normalizePath(`${this.pluginDir}/math-models`); }
	private path(name: string): string { return normalizePath(`${this.pluginDir}/math-models/${MODEL_REVISION}-${name}`); }

	/** Remove only Hand-to-TeX ONNX files owned by this plugin, including older revisions. */
	private async removeModels(keepRevision?: string): Promise<number> {
		const folder = this.folder();
		if (!await this.adapter.exists(folder)) return 0;
		const { files } = await this.adapter.list(folder);
		let removed = 0;
		for (const file of files) {
			if (!file.startsWith(`${folder}/`)) continue;
			const name = file.slice(folder.length + 1);
			if (!/^[0-9a-f]{40}-(encoder|decoder_step)\.onnx$/.test(name)) continue;
			if (keepRevision && name.startsWith(`${keepRevision}-`)) continue;
			await this.adapter.remove(file);
			removed++;
		}
		return removed;
	}

	async remove(): Promise<number> {
		if (this.downloading) {
			try { await this.downloading; } catch { /* A failed download may still leave an earlier model to remove. */ }
		}
		return this.removeModels();
	}

	async read(): Promise<{ encoder: ArrayBuffer; decoder: ArrayBuffer }> {
		const data: ArrayBuffer[] = [];
		for (const model of MATH_MODELS) {
			if (!await this.adapter.exists(this.path(model.name))) throw new Error("Download the offline recognition model in Handwriting settings first (18.5 MB).");
			const bytes = await this.adapter.readBinary(this.path(model.name));
			verifyMathModel(bytes, model);
			data.push(bytes);
		}
		return { encoder: data[0]!, decoder: data[1]! };
	}

	/** Only called by the settings download button. Recognition itself has no network path. */
	download(progress: (message: string) => void): Promise<void> {
		if (this.downloading) return this.downloading;
		this.downloading = this.downloadFiles(progress).finally(() => { this.downloading = null; });
		return this.downloading;
	}

	private async downloadFiles(progress: (message: string) => void): Promise<void> {
		const folder = this.folder();
		if (!await this.adapter.exists(folder)) await this.adapter.mkdir(folder);
		for (const model of MATH_MODELS) {
			progress(`Downloading ${model.name}…`);
			const response = await requestUrl({
				url: `https://huggingface.co/m4jkiuwr/htt-mini/resolve/${MODEL_REVISION}/${model.name}`,
				throw: false,
			});
			if (response.status !== 200) throw new Error(`Model download failed (HTTP ${response.status}). Try again later.`);
			verifyMathModel(response.arrayBuffer, model);
			await this.adapter.writeBinary(this.path(model.name), response.arrayBuffer);
		}
		try { await this.removeModels(MODEL_REVISION); }
		catch {
			progress("Offline recognition is ready, but older model files could not be removed. Use Remove model later if needed.");
			return;
		}
		progress("Offline recognition is ready.");
	}
}
