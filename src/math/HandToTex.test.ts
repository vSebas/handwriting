import { afterEach, describe, expect, it, vi } from "vitest";
import { handToTex } from "./HandToTex";
import type { MathModels } from "./MathModels";

class TestWorker {
	static instances: TestWorker[] = [];
	onerror: (() => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	postMessage = vi.fn();
	terminate = vi.fn();
	constructor() { TestWorker.instances.push(this); }
}

function setup() {
	TestWorker.instances = [];
	vi.stubGlobal("Worker", TestWorker);
	vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test");
	const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
	const models = { read: vi.fn(async () => ({ encoder: new ArrayBuffer(1), decoder: new ArrayBuffer(1) })) };
	const recognizer = handToTex(models as unknown as MathModels);
	const abort = new AbortController();
	const progress = vi.fn();
	const promise = recognizer.recognize({ traces: [[[0, 0, 0], [1, 1, 1]]] }, abort.signal, progress);
	return { promise, abort, progress, revoke };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("offline recognition lifecycle", () => {
	it("normalizes a real worker response and releases worker resources", async () => {
		const h = setup();
		await Promise.resolve();
		const worker = TestWorker.instances[0]!;
		worker.onmessage!({ data: { progress: "Decoding" } });
		worker.onmessage!({ data: { latex: "\\[x^2\\]" } });
		await expect(h.promise).resolves.toEqual({ latex: "x^2" });
		expect(h.progress).toHaveBeenCalledWith("Decoding");
		expect(worker.terminate).toHaveBeenCalledOnce();
		expect(h.revoke).toHaveBeenCalledWith("blob:test");
	});
	it("cancels an active worker when the review dialog closes", async () => {
		const h = setup();
		const result = expect(h.promise).rejects.toThrow("cancelled");
		await Promise.resolve();
		h.abort.abort();
		await result;
		expect(TestWorker.instances[0]!.terminate).toHaveBeenCalledOnce();
	});
	it("does not create a worker if cancelled while reading models", async () => {
		const h = setup();
		h.abort.abort();
		await expect(h.promise).rejects.toThrow("cancelled");
		expect(TestWorker.instances).toHaveLength(0);
	});
	it("terminates a stalled worker after the deadline", async () => {
		vi.useFakeTimers();
		const h = setup();
		const result = expect(h.promise).rejects.toThrow("too long");
		await vi.advanceTimersByTimeAsync(120_000);
		await result;
		expect(TestWorker.instances[0]!.terminate).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	});
	it("reports worker failure without changing any note or falling back to a network service", async () => {
		const h = setup();
		await Promise.resolve();
		TestWorker.instances[0]!.onerror!();
		await expect(h.promise).rejects.toThrow("WebAssembly");
		expect(TestWorker.instances).toHaveLength(1);
		expect(TestWorker.instances[0]!.terminate).toHaveBeenCalledOnce();
	});
});
