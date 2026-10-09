import { requestUrl } from "obsidian";
import { timerHost } from "../util/RuntimeScheduler";
import {
	CLIENT_HEALTH_TIMEOUT_MS, CLIENT_MODELS_TIMEOUT_MS, CLIENT_RECOGNIZE_TIMEOUT_MS,
	FIGURE_CONTEXT_MAX_CHARS, FIGURE_FEEDBACK_MAX_CHARS, MAX_BODY_BYTES, MAX_IMAGES, MAX_REDRAW_IMAGES,
} from "./CodexLimits";
import { coerceFigures, parseFigureFence, type DetectedFigure } from "./NoteFigures";

export const DEFAULT_CODEX_URL = "http://127.0.0.1:8765";
export interface CodexServiceSettings { url: string; token: string; model?: string }
export interface CodexModelOption { id: string; label: string }

export function codexEndpoint(base: string, path: "recognize-note" | "health" | "models" | "cancel"): string {
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
			cancel = () => {
				reject(new Error("Recognition cancelled."));
				// requestUrl cannot abort a request it has sent, so the race
				// above frees only the UI. This frees the LAPTOP: /cancel kills
				// the running `codex exec` and releases its single-flight slot,
				// so the next transcription is not met with 429 for minutes.
				if (path === "recognize-note") void requestUrl({ url: codexEndpoint(settings.url, "cancel"),
					method: "POST", headers: { Authorization: `Bearer ${token}` }, throw: false }).catch(() => {});
			};
			signal.addEventListener("abort", cancel, { once: true });
			timer = host.setTimeout(() => reject(new Error(path !== "recognize-note"
				? "The laptop service did not respond. Check that it is ready and reachable."
				: "Codex took too long. Try a smaller image selection.")),
				path === "health" ? CLIENT_HEALTH_TIMEOUT_MS : path === "models" ? CLIENT_MODELS_TIMEOUT_MS : CLIENT_RECOGNIZE_TIMEOUT_MS);
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
		if (response.status === 422) throw new Error("Codex misdeclared the drawn figures in this section. Transcribe again, or select a smaller area.");
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

export interface NoteRecognition { markdown: string; figures: DetectedFigure[] }

export async function recognizeWholeNoteImages(settings: CodexServiceSettings, images: string[], signal: AbortSignal,
	progress: (message: string) => void): Promise<NoteRecognition> {
	if (signal.aborted) throw new Error("Recognition cancelled.");
	if (!images.length || images.length > MAX_IMAGES) throw new Error("Select a smaller handwriting area.");
	progress("Sending the selected handwriting image to Codex...");
	const result = await serviceRequest(settings, "recognize-note", signal,
		JSON.stringify(settings.model?.trim() ? { images, model: settings.model.trim() } : { images }));
	if (typeof result.markdown !== "string" || !result.markdown.trim()) throw new Error("Codex returned no transcription. Try a clearer image selection.");
	const markdown = result.markdown.replace(/\r\n?/g, "\n").trim();
	// A bridge that answers `figures` already parsed the fence; its markdown
	// must NOT be re-parsed, or the (now fence-less) tokens read as strays and
	// vanish. An older bridge forwards the raw answer, so parse it here.
	if (Array.isArray(result.figures)) return { markdown, figures: coerceFigures(result.figures) };
	return parseFigureFence(markdown);
}

/** Ask Codex to redraw a figure as clean SVG. `images[0]` is the figure
 * crop; the rest are context (the section's ink overview, images already in
 * the note), and `context` is the surrounding transcription - both gathered
 * automatically, so overlength context is truncated rather than refused.
 * The caller sanitizes the returned markup; this only moves it. */
export async function redrawFigureImage(settings: CodexServiceSettings, images: string[], feedback: string,
	previous: string, context: string, signal: AbortSignal, progress: (message: string) => void): Promise<string> {
	if (signal.aborted) throw new Error("Recognition cancelled.");
	if (!images.length) throw new Error("The figure image is missing. Transcribe the selection again.");
	if (feedback.length > FIGURE_FEEDBACK_MAX_CHARS) throw new Error("Shorten the change request; Codex reads at most two thousand characters of it.");
	progress(feedback ? "Sending your changes to Codex..." : "Asking Codex to redraw the figure...");
	const sized = images.slice(0, MAX_REDRAW_IMAGES);
	const body: Record<string, unknown> = { task: "redraw", images: sized };
	if (settings.model?.trim()) body.model = settings.model.trim();
	if (feedback.trim()) body.feedback = feedback.trim();
	if (previous) body.previous = previous;
	if (context.trim()) body.context = context.trim().slice(0, FIGURE_CONTEXT_MAX_CHARS);
	// Context images are optional by definition: drop from the tail until the
	// request fits the bridge's body cap, instead of letting an oversized
	// optional ride-along 413 the whole redraw. Only the figure crop stays.
	// Measured as SERIALIZED UTF-8 - CJK context and JSON escaping in the
	// previous SVG make character counts undercount real bytes.
	let payload = JSON.stringify(body);
	while (sized.length > 1 && new TextEncoder().encode(payload).byteLength > MAX_BODY_BYTES) {
		sized.pop();
		payload = JSON.stringify(body);
	}
	const result = await serviceRequest(settings, "recognize-note", signal, payload);
	if (typeof result.svg !== "string" || !result.svg.trim().startsWith("<svg")) {
		throw new Error("The laptop did not return a redrawn figure. Update Handwriting on the laptop.");
	}
	return result.svg.trim();
}
