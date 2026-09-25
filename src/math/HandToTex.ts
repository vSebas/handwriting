import workerSource from "handwriting:math-worker";
import type { MathRecognizer } from "./MathRecognizer";
import type { MathModels } from "./MathModels";
import type { MathWorkerInput, MathWorkerOutput } from "./HandToTexWorker";
import { normalizeLatex } from "./Latex";
import { timerHost } from "../util/RuntimeScheduler";

export function handToTex(models: MathModels): MathRecognizer {
	return {
		name: "Hand-to-TeX",
		description: "Recognition runs on this device. No handwriting is uploaded. Download the offline model in settings before first use.",
		async recognize(ink, signal, progress) {
			progress("Reading the offline model…");
			const data = await models.read();
			if (signal.aborted) throw new Error("Recognition cancelled.");
			const url = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
			let worker: Worker | undefined;
			let timer: ReturnType<ReturnType<typeof timerHost>["setTimeout"]> | undefined;
			const host = timerHost();
			let cancel = (): void => {};
			try {
				worker = new Worker(url);
				const running = worker;
				return await new Promise((resolve, reject) => {
					cancel = () => reject(new Error("Recognition cancelled."));
					signal.addEventListener("abort", cancel, { once: true });
					timer = host.setTimeout(() => reject(new Error("Recognition took too long. Select a smaller expression and try again.")), 120_000);
					running.onerror = () => reject(new Error("Offline recognition could not start. This device may not support the required WebAssembly runtime."));
					running.onmessage = (event: MessageEvent<MathWorkerOutput>) => {
						const message = event.data;
						if ("progress" in message) progress(message.progress);
						else if ("error" in message) reject(new Error(message.error));
						else {
							try {
								const candidates: string[] = [];
								for (const value of message.candidates ?? [message.latex]) {
									try {
										const latex = normalizeLatex(value);
										if (!candidates.includes(latex)) candidates.push(latex);
									} catch { /* An invalid alternative must not hide other usable readings. */ }
									if (candidates.length === 3) break;
								}
								if (!candidates.length) throw new Error("No usable expression was recognized. Try a clearer selection.");
								resolve({ latex: candidates[0]!, candidates });
							}
							catch (error) { reject(error); }
						}
					};
					const input: MathWorkerInput = { ink, ...data };
					running.postMessage(input, [data.encoder, data.decoder]);
				});
			} finally {
				worker?.terminate();
				URL.revokeObjectURL(url);
				if (timer !== undefined) host.clearTimeout(timer);
				signal.removeEventListener("abort", cancel);
			}
		},
	};
}
