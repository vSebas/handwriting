/**
 * Every tunable of the Codex bridge, named in one place. None are
 * user-configurable: these are safety caps and pacing, not preferences.
 *
 * THE TIMEOUTS ARE ORDERED, and the order is load-bearing:
 *
 *  - CLIENT_RECOGNIZE_TIMEOUT_MS > EXEC_TIMEOUT_MS, with a margin for image
 *    upload and the reply. When `codex exec` runs out its clock, the laptop
 *    replies a typed 500 ("transcription failed, check the model") the client
 *    maps to an actionable message; were the client's clock shorter it would
 *    fire first and the user would read the generic "Codex took too long"
 *    while the laptop keeps working on an answer no one is waiting for.
 *  - CLIENT_MODELS_TIMEOUT_MS > MODEL_LIST_TIMEOUT_MS for the same reason:
 *    the laptop's "model list unavailable" 503 beats the client's guess.
 *
 * CodexLimits.test.ts pins both inequalities.
 */

/** POST /recognize-note body cap (base64 PNG tiles plus JSON overhead). */
export const MAX_BODY_BYTES = 12 * 1024 * 1024;
/** Per-image decoded pixel cap, read from the PNG header before any decode. */
export const MAX_IMAGE_PIXELS = 8_000_000;
/** Images per request: MAX_TILES detail tiles plus the layout overview. */
export const MAX_IMAGES = 9;
/** A transcription longer than this is a runaway answer, not a note. */
export const MAX_TRANSCRIPTION_CHARS = 100_000;

/** Figures Codex may declare per transcription. Matches the twelve-section
 * selection guard; MORE is a broken declaration and fails the parse loudly -
 * silently dropping one would let ink replacement delete its drawing. */
export const MAX_FIGURES = 12;
/** A redrawn figure larger than this is runaway markup, not a drawing. */
export const FIGURE_SVG_MAX_CHARS = 100_000;
/** Cap on the change-request text a redraw carries back to Codex. */
export const FIGURE_FEEDBACK_MAX_CHARS = 2_000;

/** One `codex exec` transcription, spawn to exit. */
export const EXEC_TIMEOUT_MS = 240_000;
/** `codex login status` - a local check that answers immediately or never. */
export const LOGIN_STATUS_TIMEOUT_MS = 10_000;
/** Interactive `codex login` - the user is in a browser, give them time. */
export const LOGIN_TIMEOUT_MS = 300_000;
/** `codex app-server` JSON-RPC model discovery, spawn to last page. */
export const MODEL_LIST_TIMEOUT_MS = 15_000;
/** Cap on buffered app-server stdout before discovery is abandoned. */
export const MODEL_LIST_MAX_CHARS = 2_000_000;

/** Client-side clocks for the three endpoints; see the ordering note above. */
export const CLIENT_RECOGNIZE_TIMEOUT_MS = 300_000;
export const CLIENT_MODELS_TIMEOUT_MS = 20_000;
export const CLIENT_HEALTH_TIMEOUT_MS = 10_000;

/** Detail-tile edge: large enough to keep lines of writing whole... */
export const TILE_PX = 1400;
/** ...with enough overlap that a word cut by one tile is whole in the next. */
export const TILE_OVERLAP_PX = 60;
/** Tile budget per request; the overview image is on top of this. */
export const MAX_TILES = 8;
/** Longest rendered image edge - matches what the models downscale to anyway. */
export const RENDER_MAX_EDGE_PX = 1568;

/**
 * What the wire and the UI say when no model is pinned anywhere (no override,
 * nothing in ~/.codex/config.toml). In code the unpinned state is `model:
 * null`; this label exists only at the serialization edge, so nothing ever
 * compares a model ID against an English sentence to decide behaviour.
 */
export const UNPINNED_MODEL_LABEL = "Codex CLI default (not pinned)";
