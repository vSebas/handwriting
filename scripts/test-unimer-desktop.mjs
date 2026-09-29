import { build } from "esbuild";
import { createRequire } from "node:module";

// A real Python child and real loopback HTTP request, with only Obsidian's
// requestUrl adapter replaced. This stays separate from the fast unit suite.
const bundle = await build({
	entryPoints: ["src/math/UniMERDesktop.ts"], bundle: true, write: false,
	platform: "node", format: "esm", packages: "external",
	plugins: [{ name: "obsidian-http", setup(build) {
		build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "smoke" }));
		build.onLoad({ filter: /.*/, namespace: "smoke" }, () => ({ contents: `
			export async function requestUrl({url,method,headers,body}) {
				const response = await fetch(url, {method,headers,body});
				return {status: response.status, json: await response.json()};
			}
		` }));
	}}],
});
const require = createRequire(import.meta.url);
globalThis.window = { require, setTimeout, clearTimeout };
const source = `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`;
const { LocalUniMERService } = await import(source);
const service = new LocalUniMERService(() => ({
	root: process.cwd(), url: "http://127.0.0.1:8766", token: "",
}));
if (!service.installed()) throw new Error("Local UniMERNet setup is missing.");
try {
	const token = await service.start();
	const response = await fetch("http://127.0.0.1:8766/health", { headers: { Authorization: `Bearer ${token}` } });
	if (response.status !== 200 || (await response.json()).ready !== true) throw new Error("Auto-started service is not ready.");
	console.log("desktop auto-start smoke passed: Python model loaded, authenticated health responded");
} catch (error) {
	console.error(`desktop auto-start smoke failed: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
} finally {
	service.stop();
}
