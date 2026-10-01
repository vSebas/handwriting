import { describe, expect, it } from "vitest";

import {
	CLIENT_MODELS_TIMEOUT_MS, CLIENT_RECOGNIZE_TIMEOUT_MS,
	EXEC_TIMEOUT_MS, MODEL_LIST_TIMEOUT_MS,
} from "./CodexLimits";

describe("codex bridge limits", () => {
	it("the laptop's typed error always beats the client's generic timeout", () => {
		// The module header explains why; these pin the two inequalities so a
		// future retune of one side cannot silently invert who times out first.
		expect(CLIENT_RECOGNIZE_TIMEOUT_MS).toBeGreaterThan(EXEC_TIMEOUT_MS);
		expect(CLIENT_MODELS_TIMEOUT_MS).toBeGreaterThan(MODEL_LIST_TIMEOUT_MS);
	});
});
