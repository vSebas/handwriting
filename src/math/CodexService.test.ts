import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkCodexNote, codexEndpoint, listCodexModels, recognizeWholeNoteImages } from "./CodexService";

const network = vi.hoisted(() => vi.fn());
vi.mock("obsidian", async original => ({ ...await original<object>(), requestUrl: network }));
const settings = { url: "http://192.168.1.20:8765", token: "local-test-token" };
beforeEach(() => network.mockReset());

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
});
