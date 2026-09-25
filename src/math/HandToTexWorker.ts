/** Decoder protocol adapted from Hand-to-TeX (MIT); see THIRD_PARTY_NOTICES.md. */
import * as ort from "onnxruntime-web/wasm";
import wasm from "onnxruntime-web/ort-wasm-simd-threaded.wasm";
import vocab from "./vocab.json";
import { extractFeatures } from "./HandToTexFeatures";
import type { MathInk } from "./MathRecognition";

export interface MathWorkerInput { ink: MathInk; encoder: ArrayBuffer; decoder: ArrayBuffer }
export type MathWorkerOutput = { progress: string } | { latex: string } | { error: string };

const scope = self as unknown as {
	onmessage: ((event: MessageEvent<MathWorkerInput>) => void) | null;
	postMessage(message: MathWorkerOutput): void;
};

// One thread works without SharedArrayBuffer/cross-origin isolation in the iOS webview.
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;
ort.env.wasm.wasmBinary = wasm;
const tokens = Object.values(vocab).flat();

scope.onmessage = event => { void recognize(event.data); };

async function recognize(input: MathWorkerInput): Promise<void> {
	let encoder: ort.InferenceSession | undefined;
	let decoder: ort.InferenceSession | undefined;
	const held = new Set<ort.Tensor>();
	const keep = <T extends ort.Tensor>(tensor: T): T => { held.add(tensor); return tensor; };
	const release = (tensor: ort.Tensor): void => { tensor.dispose(); held.delete(tensor); };
	try {
		scope.postMessage({ progress: "Loading the offline model…" });
		const options: ort.InferenceSession.SessionOptions = { executionProviders: ["wasm"], graphOptimizationLevel: "all" };
		encoder = await ort.InferenceSession.create(input.encoder, options);
		decoder = await ort.InferenceSession.create(input.decoder, options);
		const { flatData, numPoints, numFeatures } = extractFeatures(input.ink.traces);
		if (!numPoints || numPoints > 2048 || !flatData.every(Number.isFinite)) throw new Error("Select a smaller, valid expression.");
		scope.postMessage({ progress: "Recognizing handwriting on this device…" });
		const src = keep(new ort.Tensor("float32", flatData, [1, numPoints, numFeatures]));
		const lengths = keep(new ort.Tensor("int64", BigInt64Array.from([BigInt(numPoints)]), [1]));
		const memory = await encoder.run({ src, src_lengths: lengths });
		Object.values(memory).forEach(keep);
		release(src); release(lengths);
		const k = memory.mem_k!, v = memory.mem_v!, mask = memory.mem_mask!;
		const dims = [k.dims[0]!, 1, k.dims[2]!, 0, k.dims[4]!];
		let selfK = keep(new ort.Tensor("float32", new Float32Array(0), dims));
		let selfV = keep(new ort.Tensor("float32", new Float32Array(0), dims));
		let last = tokens.indexOf("<SOS>");
		const result: string[] = [];
		for (let step = 0; step < 149; step++) {
			const tgt = keep(new ort.Tensor("int64", BigInt64Array.from([BigInt(last)]), [1, 1]));
			const pos = keep(new ort.Tensor("int64", BigInt64Array.from([BigInt(step)]), [1]));
			const output = await decoder.run({ tgt_last: tgt, mem_k: k, mem_v: v, memory_key_padding_mask: mask, step: pos, self_k: selfK, self_v: selfV });
			Object.values(output).forEach(keep);
			release(tgt); release(pos); release(selfK); release(selfV);
			selfK = output.self_k_out! as ort.TypedTensor<"float32">;
			selfV = output.self_v_out! as ort.TypedTensor<"float32">;
			const logits = output.logits!.data as Float32Array;
			last = 0;
			for (let j = 1; j < logits.length; j++) if (logits[j]! > logits[last]!) last = j;
			release(output.logits!);
			if (last === tokens.indexOf("<EOS>")) {
				if (!result.length) throw new Error("No expression was recognized. Try a clearer selection.");
				scope.postMessage({ latex: result.join(" ") });
				return;
			}
			const token = tokens[last];
			if (!token || token.startsWith("<" ) && token.length > 1) throw new Error("The model could not read a symbol. Try a clearer selection.");
			result.push(token);
		}
		throw new Error("The expression exceeded the model's output limit. Select a smaller expression.");
	} catch (error) {
		scope.postMessage({ error: error instanceof Error ? error.message : "Offline recognition failed." });
	} finally {
		for (const tensor of held) tensor.dispose();
		await decoder?.release();
		await encoder?.release();
	}
}
