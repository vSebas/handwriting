import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkCodexNote, codexEndpoint, listCodexModels, recognizeWholeNoteImages } from "./CodexService";
import { CLIENT_HEALTH_TIMEOUT_MS, CLIENT_MODELS_TIMEOUT_MS, CLIENT_RECOGNIZE_TIMEOUT_MS } from "./CodexLimits";

const network = vi.hoisted(() => vi.fn());
vi.mock("obsidian", async original => ({ ...await original<object>(), requestUrl: network }));
const settings = { url: "http://192.168.1.20:8765", token: "local-test-token" };
// Braces matter: mockReset() returns the chainable mock, and a function
// returned from beforeEach is a TEARDOWN vitest calls (and awaits) after the
// test - which invoked network() once more, hanging on any test whose last
// mocked response never settles.
beforeEach(() => { network.mockReset(); });

describe("Codex handwriting service", () => {
	it("validates the URL and sends no image during a connection check", async () => {
		for (const url of ["", "file:///test", "http://user:pass@localhost", "http://localhost?key=secret"]) {
			expect(() => codexEndpoint(url, "health")).toThrow();
		}
		network.mockResolvedValue({ status: 200, json: { provider: "codex", ready: true, model: "gpt-test" } });
		expect(await checkCodexNote(settings)).toBe("gpt-test");
		expect(network.mock.calls[0]![0]).toMatchObject({ method: "GET", url: settings.url + "/health", body: undefined });
	});
	it("sends mixed handwriting images without a model override", async () => {
		network.mockResolvedValue({ status: 200, json: { markdown: "Text with $x^2$\r\nnext line" } });
		const images = ["data:image/png;base64,whole-note"];
		expect(await recognizeWholeNoteImages(settings, images, new AbortController().signal, () => {}))
			.toBe("Text with $x^2$\nnext line");
		expect(network.mock.calls[0]![0]).toMatchObject({ url: settings.url + "/recognize-note",
			body: JSON.stringify({ images }), headers: { Authorization: "Bearer local-test-token" } });
	});
	it("loads model choices from the same authenticated laptop bridge", async () => {
		network.mockResolvedValue({ status: 200, json: { defaultModel: "gpt-default", models: [{ id: "gpt-choice", label: "GPT Choice" }] } });
		expect(await listCodexModels(settings)).toEqual({ defaultModel: "gpt-default", models: [{ id: "gpt-choice", label: "GPT Choice" }] });
		expect(network.mock.calls[0]![0]).toMatchObject({ method: "GET", url: settings.url + "/models",
			headers: { Authorization: "Bearer local-test-token" } });
	});
	it("sends an explicit model choice with the image", async () => {
		network.mockResolvedValue({ status: 200, json: { markdown: "Text" } });
		const images = ["data:image/png;base64,whole-note"];
		await recognizeWholeNoteImages({ ...settings, model: "gpt-choice" }, images, new AbortController().signal, () => {});
		expect(network.mock.calls[0]![0].body).toBe(JSON.stringify({ images, model: "gpt-choice" }));
	});
	it("maps every bridge status to an actionable message", async () => {
		const recognize = () => recognizeWholeNoteImages(settings, ["data:image/png;base64,x"], new AbortController().signal, () => {});
		const cases: Array<[number, () => Promise<unknown>, string]> = [
			[401, recognize, "rejected the access token"],
			[413, recognize, "too large"],
			[429, recognize, "still processing another selection"],
			[400, recognize, "image is invalid"],
			[503, () => listCodexModels(settings), "Codex model list"],
			[503, recognize, "Update Handwriting on the laptop"],
			[404, recognize, "Update Handwriting on the laptop"],
			[500, recognize, "transcription failed"],
			[418, recognize, "HTTP 418"],
		];
		for (const [status, call, message] of cases) {
			network.mockResolvedValue({ status, json: {} });
			await expect(call(), `status ${status}`).rejects.toThrow(message);
		}
	});
	it("each endpoint gives up on its own clock with a path-specific message", async () => {
		vi.useFakeTimers();
		try {
			// A request that never answers: only the client's clock can end these.
			network.mockReturnValue(new Promise(() => {}));
			const paths: Array<[() => Promise<unknown>, number, string]> = [
				[() => checkCodexNote(settings), CLIENT_HEALTH_TIMEOUT_MS, "did not respond"],
				[() => listCodexModels(settings), CLIENT_MODELS_TIMEOUT_MS, "did not respond"],
				[() => recognizeWholeNoteImages(settings, ["data:image/png;base64,x"], new AbortController().signal, () => {}),
					CLIENT_RECOGNIZE_TIMEOUT_MS, "Codex took too long"],
			];
			for (const [call, clock, message] of paths) {
				const pending = call();
				pending.catch(() => {});
				await vi.advanceTimersByTimeAsync(clock);
				await expect(pending).rejects.toThrow(message);
			}
		} finally { vi.useRealTimers(); }
	});
	it("cancelling a transcription also frees the laptop", async () => {
		network.mockReturnValue(new Promise(() => {}));
		const controller = new AbortController();
		const pending = recognizeWholeNoteImages(settings, ["data:image/png;base64,x"], controller.signal, () => {});
		controller.abort();
		await expect(pending).rejects.toThrow("Recognition cancelled.");
		// The UI is free the moment the race rejects; this is what frees the
		// LAPTOP - without it the next transcription meets 429 for minutes.
		expect(network.mock.calls.at(-1)![0]).toMatchObject({ url: settings.url + "/cancel", method: "POST",
			headers: { Authorization: "Bearer local-test-token" } });
	});
});
