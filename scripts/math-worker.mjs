import * as esbuild from "esbuild";

// Package executable runtime code (including WASM) in main.js. Only model data
// is downloaded during explicit setup; recognition never fetches code from a CDN.
export function mathWorkerPlugin() {
	return {
		name: "handwriting-math-worker",
		setup(build) {
			build.onResolve({ filter: /^handwriting:math-worker$/ }, () => ({ path: "math-worker", namespace: "handwriting" }));
			build.onLoad({ filter: /.*/, namespace: "handwriting" }, async () => {
				const result = await esbuild.build({
					entryPoints: ["src/math/HandToTexWorker.ts"],
					bundle: true, write: false, minify: true, platform: "browser", format: "iife", target: "es2022",
					loader: { ".wasm": "binary" }, define: { "import.meta.url": "self.location.href" },
				});
				return { contents: `export default ${JSON.stringify(result.outputFiles[0].text)};`, loader: "js" };
			});
		},
	};
}
