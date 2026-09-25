import type { MathInk, MathResult } from "./MathRecognition";

export interface MathRecognizer {
	name: string;
	description: string;
	recognize(ink: MathInk, signal: AbortSignal, progress: (message: string) => void): Promise<MathResult>;
}
