#!/usr/bin/env node
/**
 * Copies MapLibre's web-worker module files into public/maplibre/ so the map
 * can load its worker from a plain same-origin URL.
 *
 * WHY (2026-09-13, maplibre-gl 5 -> 6): v6 is ESM-only and spawns a MODULE
 * worker from `new URL("./maplibre-gl-worker.mjs", import.meta.url)`. Under
 * Turbopack that resolution is wrong in both modes, and silently: in `next dev`
 * `import.meta.url` is not an http(s) URL, so MapLibre's default worker URL
 * is "" and `new Worker("")` fetches the page itself; in `next build` the
 * worker file is emitted under /_next/static/media with a hashed name, but it
 * imports its sibling as `./maplibre-gl-shared.mjs` — unhashed — which is a
 * 404. Either way: style loads, sprites load, zero tiles ever requested, no
 * console error. map-view.tsx therefore calls `setWorkerUrl()` with the path
 * this script fills, and the worker's relative import resolves next to it.
 *
 * Runs from the `predev` and `prebuild` hooks. public/maplibre/ is gitignored:
 * the files are node_modules content, and the version must follow the lockfile.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "maplibre-gl", "dist");
const dest = join(root, "public", "maplibre");
const version = JSON.parse(readFileSync(join(root, "node_modules", "maplibre-gl", "package.json"), "utf8")).version;

mkdirSync(dest, { recursive: true });
for (const f of ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"]) copyFileSync(join(src, f), join(dest, f));
writeFileSync(join(dest, "VERSION"), `maplibre-gl ${version}\n`);
console.log(`maplibre worker ${version} -> public/maplibre/`);
