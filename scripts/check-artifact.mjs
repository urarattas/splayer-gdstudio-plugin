import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createRoute, loadPlugin, url } from "../test/plugin-host.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactPath = resolve(
  projectRoot,
  process.argv[2] ?? "dist/gdstudio.splayer-source.js",
);

try {
  const sourceText = await readFile(artifactPath, "utf8");
  const { registration, handlers, requests } = loadPlugin({
    sourceText,
    route: createRoute({
      urls: { "netease:release-seam:999": url("https://cdn.example.test/release-seam.flac", 842) },
    }),
  });
  const qualities = ["lq", "sq", "hq", "lossless", "hi-res"];

  assert.deepEqual(Object.keys(registration.sources), ["wy"]);
  assert.deepEqual([...registration.sources.wy.actions], ["musicUrl"]);
  assert.deepEqual([...registration.sources.wy.qualities], qualities);
  assert.equal(registration.settings[0].key, "quality");
  assert.equal(registration.settings[0].default, "hi-res");
  assert.equal(typeof handlers.musicUrl, "function");

  const result = await handlers.musicUrl({
    source: "wy",
    quality: "hi-res",
    musicInfo: { songmid: "release-seam", name: "Release Seam" },
  });
  const requestUrl = requests[0].url;
  assert.equal(requestUrl.searchParams.get("types"), "url");
  assert.equal(requestUrl.searchParams.get("source"), "netease");
  assert.equal(requestUrl.searchParams.get("id"), "release-seam");
  assert.equal(requestUrl.searchParams.get("br"), "999");
  assert.equal(result.url, "https://cdn.example.test/release-seam.flac");
  assert.equal(result.quality, "lossless");

  process.stdout.write(`Verified distribution artifact: ${artifactPath}\n`);
} catch (error) {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
}
