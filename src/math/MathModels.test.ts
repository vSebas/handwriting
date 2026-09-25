import { describe, expect, it, vi } from "vitest";
import { MathModels, MATH_MODELS, verifyMathModel } from "./MathModels";

const network = vi.hoisted(() => vi.fn());
vi.mock("obsidian", async importOriginal => ({ ...await importOriginal<object>(), requestUrl: network }));

function adapter() {
	return { exists: vi.fn(async () => false), mkdir: vi.fn(async () => {}), readBinary: vi.fn(async () => new ArrayBuffer(0)), writeBinary: vi.fn(async () => {}) };
}

describe("offline model setup", () => {
	it("does not download models automatically during recognition", async () => {
		network.mockClear();
		await expect(new MathModels(adapter(), ".obsidian/plugins/handwriting").read()).rejects.toThrow("settings");
		expect(network).not.toHaveBeenCalled();
	});
	it("rejects truncated or altered model files", () => {
		expect(() => verifyMathModel(new ArrayBuffer(8), MATH_MODELS[0])).toThrow("Incomplete");
		expect(() => verifyMathModel(new ArrayBuffer(MATH_MODELS[1].size), MATH_MODELS[1])).toThrow("Invalid");
	});
	it("does not save failed downloads and allows retry", async () => {
		const store = adapter();
		const models = new MathModels(store, ".obsidian/plugins/handwriting");
		network.mockResolvedValue({ status: 503 });
		await expect(models.download(() => {})).rejects.toThrow("HTTP 503");
		expect(store.writeBinary).not.toHaveBeenCalled();
		network.mockResolvedValue({ status: 200, arrayBuffer: new ArrayBuffer(4) });
		await expect(models.download(() => {})).rejects.toThrow("Incomplete");
		expect(store.writeBinary).not.toHaveBeenCalled();
	});
});
