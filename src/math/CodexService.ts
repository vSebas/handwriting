import { requestUrl } from "obsidian";
import { timerHost } from "../util/RuntimeScheduler";

export const DEFAULT_CODEX_URL = "http://127.0.0.1:8765";
export interface CodexServiceSettings { url: string; token: string; model?: string }
export interface CodexModelOption { id: string; label: string }

export function codexEndpoint(base: string, path: "recognize-note" | "health" | "models"): string {
	let url: URL;
	try { url = new URL(base.trim()); } catch { throw new Error("Enter the laptop service URL in Handwriting settings."); }
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
		throw new Error("Use an HTTP or HTTPS service URL without credentials, query parameters or fragments.");
	}
	url.pathname = `${url.pathname.replace(/\/$/, "")}/${path}`;
	return url.href;
}

async function serviceRequest(settings: CodexServiceSettings, path: "recognize-note" | "health" | "models", signal: AbortSignal, body?: string): Promise<Record<string, unknown>> {
	if (signal.aborted) throw new Error("Recognition cancelled.");
	const url = codexEndpoint(settings.url, path);
	const token = settings.token.trim();
	if (!token) throw new Error("Enter the laptop service access token in Handwriting settings.");
	const host = timerHost();
	let timer: ReturnType<typeof host.setTimeout> | undefined;
	let cancel = (): void => {};
	try {
		const stopped = new Promise<never>((_, reject) => {
			cancel = () => reject(new Error("Recognition cancelled."));
			signal.addEventListener("abort", cancel, { once: true });
			timer = host.setTimeout(() => reject(new Error(path !== "recognize-note"
				? "The laptop service did not respond. Check that it is ready and reachable."
				: "Codex took too long. Try a smaller image selection.")), path === "health" ? 10_000 : path === "models" ? 20_000 : 300_000);
		});
		const request = requestUrl({ url, method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${token}` },
			contentType: "application/json", body, throw: false }).catch(() => {
			throw new Error("Could not reach the laptop service. Check its address and network connection.");
		});
		const response = await Promise.race([request, stopped]);
		if (response.status === 401) throw new Error("The laptop service rejected the access token.");
		if (response.status === 413) throw new Error("The handwriting image is too large. Select a smaller area of the note.");
		if (response.status === 429) throw new Error("Codex is still processing another selection. Wait for it to finish.");
		if (response.status === 400) throw new Error("The handwriting image is invalid. Try a smaller selection.");
		if (response.status === 503 && path === "models") throw new Error("The laptop could not read the Codex model list. Check its Codex CLI installation.");
		if (response.status === 503 || response.status === 404) throw new Error("Update Handwriting on the laptop and sign in to Codex CLI.");
		if (response.status === 500) throw new Error("Codex transcription failed. Check the selected model and laptop sign-in.");
		if (response.status !== 200) throw new Error(`Laptop service failed (HTTP ${response.status}).`);
		const value: unknown = response.json;
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The laptop service returned an invalid response.");
		return value as Record<string, unknown>;
	} finally {
		if (timer !== undefined) host.clearTimeout(timer);
		signal.removeEventListener("abort", cancel);
	}
}

export async function checkCodexNote(settings: CodexServiceSettings): Promise<string> {
	const result = await serviceRequest(settings, "health", new AbortController().signal);
	if (result.provider !== "codex" || result.ready !== true) throw new Error("The Codex service is not ready on the laptop.");
	return typeof result.model === "string" ? result.model : "Codex default";
}

export async function listCodexModels(settings: CodexServiceSettings): Promise<{ models: CodexModelOption[]; defaultModel: string }> {
	const result = await serviceRequest(settings, "models", new AbortController().signal);
	if (!Array.isArray(result.models) || result.models.some(item => !item || typeof item !== "object" ||
		typeof item.id !== "string" || typeof item.label !== "string")) {
		throw new Error("The laptop returned an invalid Codex model list.");
	}
	return { models: result.models as CodexModelOption[], defaultModel: typeof result.defaultModel === "string" ? result.defaultModel : "Codex CLI default" };
}

export async function recognizeWholeNoteImages(settings: CodexServiceSettings, images: string[], signal: AbortSignal,
	progress: (message: string) => void): Promise<string> {
	if (signal.aborted) throw new Error("Recognition cancelled.");
	if (!images.length || images.length > 9) throw new Error("Select a smaller handwriting area.");
	progress("Sending the selected handwriting image to Codex...");
	const result = await serviceRequest(settings, "recognize-note", signal,
		JSON.stringify(settings.model?.trim() ? { images, model: settings.model.trim() } : { images }));
	if (typeof result.markdown !== "string" || !result.markdown.trim()) throw new Error("Codex returned no transcription. Try a clearer image selection.");
	return result.markdown.replace(/\r\n?/g, "\n").trim();
}
