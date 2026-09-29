import { requestUrl } from "obsidian";
import type { MathRecognizer } from "./MathRecognizer";
import type { MathInk } from "./MathRecognition";
import { mathInkImage } from "./MathInkImage";
import { normalizeLatex } from "./Latex";
import { timerHost } from "../util/RuntimeScheduler";

export const DEFAULT_UNIMER_URL = "http://127.0.0.1:8765";
export interface UniMERSettings { url: string; token: string }

export function uniMEREndpoint(base: string, path: "recognize" | "recognize-text" | "health"): string {
	let url: URL;
	try { url = new URL(base.trim()); } catch { throw new Error("Enter the UniMERNet service URL in Handwriting settings."); }
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
		throw new Error("Use an HTTP or HTTPS service URL without credentials, query parameters or fragments.");
	}
	url.pathname = `${url.pathname.replace(/\/$/, "")}/${path}`;
	return url.href;
}

/** requestUrl works in both mobile and desktop Obsidian without browser CORS. */
async function serviceRequest(settings: UniMERSettings, path: "recognize" | "recognize-text" | "health", signal: AbortSignal, body?: string): Promise<Record<string, unknown>> {
	if (signal.aborted) throw new Error("Recognition cancelled.");
	const url = uniMEREndpoint(settings.url, path);
	const token = settings.token.trim();
	if (!token) throw new Error("Enter the UniMERNet access token from your local service in Handwriting settings.");
	const host = timerHost();
	let timer: ReturnType<typeof host.setTimeout> | undefined;
	let cancel = (): void => {};
	try {
		const stopped = new Promise<never>((_, reject) => {
			cancel = () => reject(new Error("Recognition cancelled."));
			signal.addEventListener("abort", cancel, { once: true });
			timer = host.setTimeout(() => reject(new Error(path === "health"
				? "UniMERNet did not respond. Check that the laptop service is ready and reachable."
				: "UniMERNet took too long. The laptop may still be processing; try a smaller expression when it finishes.")), path === "health" ? 10_000 : 180_000);
		});
		const request = requestUrl({ url, method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${token}` },
			contentType: "application/json", body, throw: false }).catch(() => {
			throw new Error("Could not reach UniMERNet. Start the laptop service and check its address and network connection.");
		});
		const response = await Promise.race([request, stopped]);
		if (response.status === 401) throw new Error("UniMERNet rejected the access token. Copy the token from the laptop service settings.");
		if (response.status === 429) throw new Error("UniMERNet is still processing another expression. Wait for it to finish, then try again.");
		if ((response.status === 503 || response.status === 404) && path === "recognize-text") throw new Error("Update the laptop service, install its optional handwritten-text model, then restart desktop Obsidian.");
		if (response.status !== 200) throw new Error(`UniMERNet service failed (HTTP ${response.status}). Check the laptop service window.`);
		let value: unknown;
		try { value = response.json; } catch { throw new Error("UniMERNet returned an invalid response."); }
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("UniMERNet returned an invalid response.");
		return value as Record<string, unknown>;
	} finally {
		if (timer !== undefined) host.clearTimeout(timer);
		signal.removeEventListener("abort", cancel);
	}
}

export async function checkUniMERNet(settings: UniMERSettings): Promise<void> {
	const result = await serviceRequest(settings, "health", new AbortController().signal);
	if (result.provider !== "unimernet" || result.ready !== true) throw new Error("UniMERNet is not ready. Wait for the laptop to load the model.");
}

export async function checkHandwrittenText(settings: UniMERSettings): Promise<void> {
	const result = await serviceRequest(settings, "health", new AbortController().signal);
	if (result.text_ready !== true) throw new Error("Update the laptop service, install its optional handwritten-text model, then restart desktop Obsidian.");
}

export async function recognizeHandwrittenText(settings: UniMERSettings, ink: MathInk, signal: AbortSignal,
	progress: (message: string) => void): Promise<string> {
	if (signal.aborted) throw new Error("Recognition cancelled.");
	uniMEREndpoint(settings.url, "recognize-text");
	if (!settings.token.trim()) throw new Error("Enter the UniMERNet access token in Handwriting settings.");
	progress("Reading handwritten text on your laptop...");
	const result = await serviceRequest(settings, "recognize-text", signal, JSON.stringify({ image: mathInkImage(ink) }));
	if (typeof result.text !== "string" || !result.text.trim()) throw new Error("No text was recognized. Select one or more clear text lines.");
	return result.text.replace(/\r\n?/g, "\n").trim();
}

export function uniMERNet(settings: UniMERSettings): MathRecognizer {
	return {
		name: "UniMERNet",
		description: "The selected ink is sent as an image to your configured UniMERNet service. Keep the laptop running and reachable.",
		async recognize(ink, signal, progress) {
			if (signal.aborted) throw new Error("Recognition cancelled.");
			// Validate configuration before rendering or making a request.
			uniMEREndpoint(settings.url, "recognize");
			if (!settings.token.trim()) throw new Error("Enter the UniMERNet access token from your local service in Handwriting settings.");
			progress("Sending selected handwriting to UniMERNet...");
			const result = await serviceRequest(settings, "recognize", signal, JSON.stringify({ image: mathInkImage(ink) }));
			if (typeof result.latex !== "string") throw new Error("UniMERNet returned no expression. Try a clearer selection.");
			return { latex: normalizeLatex(result.latex) };
		},
	};
}
