/** Decoder protocol adapted from Hand-to-TeX (MIT); see THIRD_PARTY_NOTICES.md. */
import * as ort from "onnxruntime-web/wasm";
import wasm from "onnxruntime-web/ort-wasm-simd-threaded.wasm";
import vocab from "./vocab.json";
import { extractFeatures } from "./HandToTexFeatures";
import type { MathInk } from "./MathRecognition";
import { beamSearch } from "./BeamSearch";

export interface MathWorkerInput { ink: MathInk; encoder: ArrayBuffer; decoder: ArrayBuffer }
export type MathWorkerOutput = { progress: string } | { latex: string; candidates: string[] } | { error: string };

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
		scope.postMessage({ progress: "Comparing possible readings on this device…" });
		const src = keep(new ort.Tensor("float32", flatData, [1, numPoints, numFeatures]));
		const lengths = keep(new ort.Tensor("int64", BigInt64Array.from([BigInt(numPoints)]), [1]));
		const memory = await encoder.run({ src, src_lengths: lengths });
		Object.values(memory).forEach(keep);
		release(src); release(lengths);
		const k = memory.mem_k!, v = memory.mem_v!, mask = memory.mem_mask!;
		const dims = [k.dims[0]!, 1, k.dims[2]!, 0, k.dims[4]!];
		const initialState = {
			k: keep(new ort.Tensor("float32", new Float32Array(0), dims)),
			v: keep(new ort.Tensor("float32", new Float32Array(0), dims)),
		};
		const eos = tokens.indexOf("<EOS>");
		const results = await beamSearch({
			initialState, startToken: tokens.indexOf("<SOS>"), endToken: eos,
			allowedToken: id => id === eos || !!tokens[id] && !(tokens[id]!.startsWith("<") && tokens[id]!.length > 1),
			dispose: state => { release(state.k); release(state.v); },
			decode: async (last, step, state) => {
				const tgt = keep(new ort.Tensor("int64", BigInt64Array.from([BigInt(last)]), [1, 1]));
				const pos = keep(new ort.Tensor("int64", BigInt64Array.from([BigInt(step)]), [1]));
				const output = await decoder!.run({ tgt_last: tgt, mem_k: k, mem_v: v, memory_key_padding_mask: mask, step: pos, self_k: state.k, self_v: state.v });
				Object.values(output).forEach(keep);
				release(tgt); release(pos);
				const logits = new Float32Array(output.logits!.data as Float32Array);
				release(output.logits!);
				return { logits, state: { k: output.self_k_out! as ort.TypedTensor<"float32">, v: output.self_v_out! as ort.TypedTensor<"float32"> } };
			},
		});
		const candidates = [...new Set(results.map(result => result.tokenIds.map(id => tokens[id]).join(" ")))];
		if (!candidates.length) throw new Error("No complete expression was recognized. Select a smaller or clearer expression.");
		scope.postMessage({ latex: candidates[0]!, candidates });
	} catch (error) {
		scope.postMessage({ error: error instanceof Error ? error.message : "Offline recognition failed." });
	} finally {
		for (const tensor of held) tensor.dispose();
		await decoder?.release();
		await encoder?.release();
	}
}
