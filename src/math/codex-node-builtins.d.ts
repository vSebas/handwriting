/**
 * The node builtins the Codex bridge and its test use, declared as narrowly
 * as the ones in test/render/node-builtins.d.ts. The repo carries no
 * @types/node on purpose (see that file): with it installed, upstream's
 * `setTimeout` handles type as `Timeout` instead of `number` and the build
 * breaks. The bridge reaches node through desktop Obsidian's `window.require`
 * and types each module as `typeof import("node:...")`, so these ambient
 * modules are exactly what it sees. Each block MERGES with any declaration
 * of the same module elsewhere in the repo.
 */
declare class Buffer extends Uint8Array {
	static from(data: string | Uint8Array | ArrayBuffer | readonly number[], encoding?: string): Buffer;
	static concat(list: readonly Uint8Array[]): Buffer;
	static alloc(size: number, fill?: number): Buffer;
	toString(encoding?: string): string;
	subarray(start?: number, end?: number): Buffer;
	readUInt32BE(offset: number): number;
	writeUInt32BE(value: number, offset: number): number;
	copy(target: Uint8Array, targetStart?: number): number;
	equals(other: Uint8Array): boolean;
}

declare module "node:fs" {
	export function readdirSync(path: string): string[];
	export function readFileSync(path: string): Buffer;
	export function mkdtempSync(prefix: string): string;
	export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
	export const promises: {
		mkdtemp(prefix: string): Promise<string>;
		writeFile(path: string, data: string | Uint8Array, encoding?: string): Promise<void>;
		readFile(path: string, encoding: "utf8"): Promise<string>;
		rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
	};
}

declare module "node:path" {
	const delimiter: string;
}

declare module "node:os" {
	export function homedir(): string;
	export function tmpdir(): string;
}

declare module "node:crypto" {
	export function randomBytes(size: number): Buffer;
}

declare module "node:process" {
	export const platform: string;
	export const env: Record<string, string | undefined>;
}

declare module "node:events" {
	export class EventEmitter {
		on(event: string, listener: (...args: any[]) => void): this;
		once(event: string, listener: (...args: any[]) => void): this;
		off(event: string, listener: (...args: any[]) => void): this;
		emit(event: string, ...args: any[]): boolean;
	}
}

declare module "node:stream" {
	import { EventEmitter } from "node:events";
	export class PassThrough extends EventEmitter {
		write(chunk: string | Uint8Array): boolean;
	}
}

declare module "node:child_process" {
	export interface ChildProcess {
		kill(): void;
		once(event: "error", listener: (error: Error) => void): this;
		once(event: "close", listener: (code: number | null) => void): this;
		stdin: { write(chunk: string): boolean };
		stdout: { on(event: "data", listener: (chunk: Buffer) => void): void };
	}
	export function spawn(command: string, args: readonly string[], options?: {
		cwd?: string; windowsHide?: boolean; stdio?: string | readonly string[]; env?: Record<string, string | undefined>;
	}): ChildProcess;
}

declare module "node:http" {
	export interface IncomingMessage extends AsyncIterable<Buffer> {
		headers: Record<string, string | string[] | undefined>;
		method?: string;
		url?: string;
	}
	export interface ServerResponse {
		headersSent: boolean;
		writeHead(status: number, headers?: Record<string, string>): this;
		end(data?: string): void;
	}
	export interface Server {
		listen(port: number, host: string, listening: () => void): this;
		close(): this;
		closeAllConnections?(): void;
		once(event: "error", listener: (error: Error) => void): this;
		off(event: "error", listener: (error: Error) => void): this;
	}
	export interface ClientRequest {
		on(event: "error", listener: (error: Error) => void): this;
		write(chunk: string): boolean;
		destroy(): void;
	}
	export function createServer(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>): Server;
	export function request(url: string, options: { method: string; headers: Record<string, string> },
		callback: (response: { statusCode?: number; resume(): void }) => void): ClientRequest;
}
