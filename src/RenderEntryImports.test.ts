/**
 * EVERY MODULE A RENDER TEST IMPORTS OR BUNDLES STILL EXISTS.
 *
 * The render suite is excluded from `npm test` (vitest.config.mts documents
 * why), so it runs only in `npm run gate` and CI - and a render test whose
 * import rotted fails THERE, days after the commit that broke it. That is not
 * hypothetical: MathCandidates.test.ts kept bundling MathRecognitionModal for
 * four commits after bf1c3aa deleted it, with `npm test` green the whole time.
 *
 * `tsc` cannot catch this class of breakage. The render tests hand esbuild a
 * `stdin.contents` template string whose imports resolve against the repo root
 * at BUNDLE time; to the type checker they are just text. So this guard reads
 * the render tests as text too: every relative specifier - in real import
 * statements and inside those stdin strings alike - must resolve to a file.
 *
 * Specifiers come in two address spaces, and a specifier passes if it resolves
 * in either: real imports are relative to test/render/, stdin specifiers to
 * the repo root (their build uses `resolveDir: "../../"`). Collapsing the two
 * trades a sliver of strictness (a dead import that happens to exist in the
 * other space) for not having to parse which string sits inside which
 * template, and the failure this guard exists for - a deleted module - fails
 * both spaces anyway.
 */

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const RENDER_DIR = `${ROOT}test/render`;

/** Matches `from "./x"`, `import "./x"` and `import("./x")` - plain text, so
 * it sees inside esbuild stdin template strings exactly like real code. */
const SPECIFIER = /(?:from|import)\s*\(?\s*"(\.[^"]+)"/g;

function specifiersIn(text: string): string[] {
	const found: string[] = [];
	for (const match of text.matchAll(SPECIFIER)) found.push(match[1]!);
	return found;
}

/** A specifier resolves the way esbuild would: as written (explicit
 * extensions, fixtures), or with the extensions the suite actually uses. */
function resolves(base: string, spec: string): boolean {
	const bare = spec.replace(/\?[^?]*$/, "");
	return [bare, `${bare}.ts`, `${bare}.css`, `${bare}/index.ts`].some(candidate =>
		existsSync(`${base}/${candidate}`)
	);
}

describe("render test entry imports", () => {
	it("every module a render test imports or bundles still exists", () => {
		const files = readdirSync(RENDER_DIR).filter(name => name.endsWith(".ts"));
		// Without this a broken walk reports an empty list and passes.
		expect(files.length, "the render-test walk found nothing").toBeGreaterThan(0);

		let checked = 0;
		const missing: string[] = [];
		for (const file of files) {
			for (const spec of specifiersIn(readFileSync(`${RENDER_DIR}/${file}`, "utf8"))) {
				checked++;
				if (!resolves(RENDER_DIR, spec) && !resolves(ROOT, spec)) {
					missing.push(`test/render/${file}: "${spec}"`);
				}
			}
		}
		// A regex that stopped matching would also report nothing missing.
		expect(checked, "no relative specifiers were found at all").toBeGreaterThan(0);
		expect(
			missing,
			`${missing.length} render-test import(s) point at nothing:\n${missing.join("\n")}`
		).toEqual([]);
	});

	it("the extraction is live: it sees stdin strings and skips package imports", () => {
		const sample = `
			import { build } from "esbuild";
			import { harness } from "./harness";
			const bundle = await build({ stdin: { contents: \`
				import { Modal } from "./src/math/Gone";
				import "./test/render/obsidianDom";
			\` } });
			const dynamic = await import("../obsidian-stub");
		`;
		expect(specifiersIn(sample)).toEqual([
			"./harness",
			"./src/math/Gone",
			"./test/render/obsidianDom",
			"../obsidian-stub",
		]);
	});
});
