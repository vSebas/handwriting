import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkUniMERNet, uniMEREndpoint, uniMERNet } from "./UniMERNet";

const network = vi.hoisted(() => vi.fn());
const render = vi.hoisted(() => vi.fn(() => "data:image/png;base64,test"));
vi.mock("obsidian", async original => ({ ...await original<object>(), requestUrl: network }));
vi.mock("./MathInkImage", () => ({ mathInkImage: render }));
const settings = { url: "http://192.168.1.20:8765", token: "local-test-token" };
const ink = { traces: [[[0, 0, 0] as [number, number, number]]] };
const recognize = (signal = new AbortController().signal) => uniMERNet(settings).recognize(ink, signal, () => {});
beforeEach(() => { network.mockReset(); render.mockClear(); });
afterEach(() => vi.useRealTimers());

describe("UniMERNet service provider", () => {
	it("uploads only the selected PNG to the configured service and normalizes LaTeX", async () => {
		network.mockResolvedValue({ status: 200, json: { latex: "\\[x^2\\]" } });
		expect(await recognize()).toEqual({ latex: "x^2" });
		expect(render).toHaveBeenCalledWith(ink);
		expect(network).toHaveBeenCalledExactlyOnceWith({ url: settings.url + "/recognize", method: "POST",
			headers: { Authorization: "Bearer local-test-token" }, contentType: "application/json",
			body: JSON.stringify({ image: "data:image/png;base64,test" }), throw: false });
	});
	it("validates service configuration without sending ink", async () => {
		for (const url of ["", "file:///test", "http://user:password@localhost", "http://localhost?key=secret", "http://localhost#fragment"]) {
			expect(() => uniMEREndpoint(url, "recognize")).toThrow();
		}
		expect(uniMEREndpoint("https://example.test/unimer/", "health")).toBe("https://example.test/unimer/health");
		await expect(uniMERNet({ ...settings, token: "" }).recognize(ink, new AbortController().signal, () => {})).rejects.toThrow("access token");
		expect(network).not.toHaveBeenCalled(); expect(render).not.toHaveBeenCalled();
	});
	it("connection check sends no handwriting and verifies the service identity", async () => {
		network.mockResolvedValue({ status: 200, json: { provider: "unimernet", ready: true } });
		await checkUniMERNet(settings);
		expect(network.mock.calls[0]![0]).toMatchObject({ method: "GET", url: settings.url + "/health", body: undefined });
		expect(render).not.toHaveBeenCalled();
		network.mockResolvedValue({ status: 200, json: {} });
		await expect(checkUniMERNet(settings)).rejects.toThrow("not ready");
	});
	it.each([[401, "access token"], [429, "another expression"], [500, "HTTP 500"]])("handles HTTP %s without retrying", async (status, message) => {
		network.mockResolvedValue({ status, json: {} });
		await expect(recognize()).rejects.toThrow(String(message));
		expect(network).toHaveBeenCalledTimes(1);
	});
	it("does not display low-level errors that might contain credentials", async () => {
		network.mockRejectedValue(new Error("local-test-token"));
		await expect(recognize()).rejects.toThrow("Could not reach UniMERNet");
	});
	it.each([null, [], {}, { latex: 42 }, { latex: "" }])("rejects unusable results: %j", async json => {
		network.mockResolvedValue({ status: 200, json });
		await expect(recognize()).rejects.toThrow();
	});
	it("cancels the client wait and ignores late completion", async () => {
		const controller = new AbortController();
		let finish!: (value: unknown) => void;
		network.mockReturnValue(new Promise(resolve => { finish = resolve; }));
		const pending = recognize(controller.signal);
		controller.abort();
		await expect(pending).rejects.toThrow("cancelled");
		finish({ status: 200, json: { latex: "late" } });
		await expect(recognize(controller.signal)).rejects.toThrow("cancelled");
		expect(network).toHaveBeenCalledTimes(1);
	});
	it("bounds the wait without issuing automatic duplicate requests", async () => {
		vi.useFakeTimers(); network.mockReturnValue(new Promise(() => {}));
		const assertion = expect(recognize()).rejects.toThrow("took too long");
		await vi.advanceTimersByTimeAsync(180_000); await assertion;
		expect(network).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
	});
});
