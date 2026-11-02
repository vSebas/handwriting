import { describe, expect, it, vi } from "vitest";
import { HandwritingPlugin } from "../main";
import lifecycleRaw from "../PluginLifecycle.ts?raw";

/**
 * The plugin slice of Codex transcription, driven on an `Object.create`
 * instance the way the settings tests drive loadSettings: no field
 * initialisers, the collaborators supplied by hand.
 */
function plugin(): Record<string, unknown> {
	const p = Object.create(HandwritingPlugin.prototype) as Record<string, unknown>;
	p.settings = { codexEnabled: true, codexServiceUrl: "http://127.0.0.1:8765", codexServiceToken: "t", codexModel: "",
		inkFolder: ".handwriting", mouseInk: false, slidesInk: false, pressureSensitivity: true, inkSmoothing: true,
		booxMode: false, inkAdaptsToTheme: false };
	p.codexService = { stop: vi.fn() };
	p.wholeNoteModal = { close: vi.fn() };
	p.selectionModal = { close: vi.fn() };
	return p;
}

describe("the Codex plugin slice", () => {
	it("closes both review dialogs and forgets them", () => {
		const p = plugin();
		const whole = p.wholeNoteModal as { close: ReturnType<typeof vi.fn> }, lasso = p.selectionModal as { close: ReturnType<typeof vi.fn> };
		(p as unknown as HandwritingPlugin).closeCodexDialogs();
		expect(whole.close).toHaveBeenCalledOnce();
		expect(lasso.close).toHaveBeenCalledOnce();
		expect(p.wholeNoteModal).toBeNull();
		expect(p.selectionModal).toBeNull();
	});

	it("stop is sticky-safe: the instance is dropped so re-enabling builds a fresh one", () => {
		const p = plugin();
		const service = p.codexService as { stop: ReturnType<typeof vi.fn> };
		(p as unknown as HandwritingPlugin).stopLocalCodexService();
		expect(service.stop).toHaveBeenCalledOnce();
		expect(p.codexService).toBeNull();
		// Idempotent: unload after a toggle-off finds nothing to stop.
		(p as unknown as HandwritingPlugin).stopLocalCodexService();
	});

	it("a synced codexEnabled: false stops the bridge, a synced true starts it", () => {
		// Another device flipped the switch and data.json synced over: the LAN
		// listener must follow, not keep answering authenticated requests.
		const p = plugin();
		const service = p.codexService as { stop: ReturnType<typeof vi.fn> };
		p.store = { useInkFolder: vi.fn() };
		p.settingsSnapshot = (s: unknown) => s;
		p.applyRuntimeSettings = vi.fn();
		p.refreshSettingSurfaces = vi.fn();
		p.applySlidesInk = vi.fn();
		const started = vi.fn();
		p.startLocalCodexServiceQuietly = started;
		const merged = { ...(p.settings as object), codexEnabled: false };
		(p as unknown as { takeMergedSettings(m: unknown): void }).takeMergedSettings(merged);
		expect(service.stop).toHaveBeenCalledOnce();
		expect(p.codexService).toBeNull();
		expect(started).not.toHaveBeenCalled();
		(p as unknown as { takeMergedSettings(m: unknown): void }).takeMergedSettings({ ...merged, codexEnabled: true });
		expect(started).toHaveBeenCalledOnce();
	});

	it("unload closes the dialogs before it stops the bridge", () => {
		// A source pin, like FreezeFlushWired: the two calls exist and in that
		// order, so an iPad dialog mid-recognition is aborted (and /cancel sent)
		// rather than left actionable over a plugin that is gone.
		const close = lifecycleRaw.indexOf("this.closeCodexDialogs();");
		const stop = lifecycleRaw.indexOf("this.stopLocalCodexService();");
		expect(close).toBeGreaterThan(-1);
		expect(stop).toBeGreaterThan(close);
	});
});
