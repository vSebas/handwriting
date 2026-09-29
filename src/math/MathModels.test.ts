import { describe, expect, it, vi } from "vitest";
import { MathModels, MATH_MODELS, verifyMathModel } from "./MathModels";

const network = vi.hoisted(() => vi.fn());
vi.mock("obsidian", async importOriginal => ({ ...await importOriginal<object>(), requestUrl: network }));

function adapter() {
	return { exists: vi.fn(async () => false), mkdir: vi.fn(async () => {}), list: vi.fn(async () => ({ files: [] as string[], folders: [] as string[] })), remove: vi.fn(async (_path: string) => {}), readBinary: vi.fn(async () => new ArrayBuffer(0)), writeBinary: vi.fn(async () => {}) };
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
	it("removes only Hand-to-TeX model files from this plugin folder", async () => {
		const folder = ".obsidian/plugins/handwriting/math-models";
		const store = adapter();
		store.exists.mockResolvedValue(true);
		store.list.mockResolvedValue({ files: [
			`${folder}/${MATH_MODELS[0].name}`,
			`${folder}/58170cc16748a5652e5e58caf93019fb8b0603c4-encoder.onnx`,
			`${folder}/58170cc16748a5652e5e58caf93019fb8b0603c4-decoder_step.onnx`,
			`${folder}/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-encoder.onnx`,
			`${folder}/notes.txt`,
			`.obsidian/plugins/another/math-models/58170cc16748a5652e5e58caf93019fb8b0603c4-encoder.onnx`,
		], folders: [] });
		const count = await new MathModels(store, ".obsidian/plugins/handwriting").remove();
		expect(count).toBe(3);
		expect(store.remove.mock.calls.map(([file]) => file)).toEqual([
			`${folder}/58170cc16748a5652e5e58caf93019fb8b0603c4-encoder.onnx`,
			`${folder}/58170cc16748a5652e5e58caf93019fb8b0603c4-decoder_step.onnx`,
			`${folder}/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-encoder.onnx`,
		]);
	});
});
