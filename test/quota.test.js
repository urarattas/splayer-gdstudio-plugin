import assert from "node:assert/strict";
import { test } from "node:test";

import { createRoute, loadPlugin, url } from "./plugin-host.js";

const neteaseTrack = {
  songmid: "18902710",
  name: "Love",
  singer: "Keyshia Cole",
  interval: "04:15",
};

const bitrates = (requests) =>
  requests
    .filter(({ url: requestUrl }) => requestUrl.searchParams.get("types") === "url")
    .map(({ url: requestUrl }) => requestUrl.searchParams.get("br"));

test("economy mode only tries the target tier and 128k", async () => {
  const { handlers, requests } = loadPlugin({
    settings: { economyMode: true, crossPlatformFallback: false },
  });

  await assert.rejects(
    handlers.musicUrl({ source: "wy", quality: "hi-res", musicInfo: neteaseTrack }),
    (error) => error.code === "GD_NO_URL",
  );
  assert.deepEqual(bitrates(requests), ["999", "128"]);
});

test("playable-first puts lossless tiers at the end of the ladder", async () => {
  const { handlers, requests } = loadPlugin({
    settings: { playableFirst: true },
    route: createRoute({ urls: { "netease:18902710:320": url("https://cdn.example.test/song.mp3", 320) } }),
  });

  const result = await handlers.musicUrl({
    source: "wy",
    quality: "hi-res",
    musicInfo: neteaseTrack,
  });

  assert.deepEqual(bitrates(requests), ["320"]);
  assert.equal(result.quality, "hq");
});

test("remembering an unavailable track skips its whole ladder next time", async () => {
  const { handlers, requests } = loadPlugin({
    settings: { quality: "lossless" },
    route: createRoute(),
  });

  const request = { source: "wy", quality: "lossless", musicInfo: neteaseTrack };
  await assert.rejects(handlers.musicUrl(request), (error) => error.code === "GD_TRACK_UNAVAILABLE");
  const firstRound = requests.length;
  assert.equal(firstRound, 5);

  await assert.rejects(handlers.musicUrl(request), (error) => error.code === "GD_TRACK_UNAVAILABLE");
  assert.equal(requests.length, firstRound);
});

test("expires cached playback URLs after ninety seconds", async () => {
  let clock = 1_800_000_000_000;
  const { handlers, requests } = loadPlugin({
    now: () => clock,
    route: createRoute({
      urls: { "netease:18902710:999": url("https://cdn.example.test/song.flac", 842) },
    }),
  });

  const request = { source: "wy", quality: "hi-res", musicInfo: neteaseTrack };
  await handlers.musicUrl(request);
  clock += 90_000 + 1;
  await handlers.musicUrl(request);

  assert.equal(requests.length, 2);
});

test("clears cached responses when the configuration changes", async () => {
  const host = loadPlugin({
    route: createRoute({ urls: { "netease:18902710:999": url("https://cdn.example.test/song.flac", 842) } }),
  });

  const request = { source: "wy", quality: "hi-res", musicInfo: neteaseTrack };
  await host.handlers.musicUrl(request);
  host.setSetting("crossPlatformFallback", false);
  await host.handlers.musicUrl(request);

  assert.equal(host.requests.length, 2);
});

test("maps a host request timeout to the resolution timeout error", async () => {
  const { handlers } = loadPlugin({
    route: () => Promise.reject({ code: "PLUGIN_REQUEST_TIMEOUT", message: "host timeout" }),
  });

  await assert.rejects(
    handlers.musicUrl({ source: "wy", quality: "hq", musicInfo: neteaseTrack }),
    (error) => {
      assert.equal(error.code, "GD_RESOLUTION_TIMEOUT");
      assert.match(error.message, /时间上限/);
      return true;
    },
  );
});

test("maps transport failures to GD_NETWORK_ERROR", async () => {
  const { handlers } = loadPlugin({
    route: () => Promise.reject(new Error("connect ECONNREFUSED")),
  });

  await assert.rejects(
    handlers.musicUrl({ source: "wy", quality: "hq", musicInfo: neteaseTrack }),
    (error) => {
      assert.equal(error.code, "GD_NETWORK_ERROR");
      assert.match(error.message, /ECONNREFUSED/);
      return true;
    },
  );
});

test("does not downgrade a tier when the host cannot run the delivery probe", async () => {
  const { handlers } = loadPlugin({
    route: createRoute({ urls: { "netease:18902710:999": url("https://cdn.example.test/song.flac", 842) } }),
    probeResponse: () => Promise.reject({ code: "PLUGIN_ACTION_UNSUPPORTED", message: "no ranges" }),
  });

  const result = await handlers.musicUrl({
    source: "wy",
    quality: "hi-res",
    musicInfo: neteaseTrack,
  });

  assert.equal(result.url, "https://cdn.example.test/song.flac");
  assert.equal(result.quality, "lossless");
});
