import assert from "node:assert/strict";
import { test } from "node:test";

import { createRoute, loadPlugin, track, url } from "./plugin-host.js";

const neteaseTrack = {
  songmid: "18902710",
  name: "Love",
  singer: "Keyshia Cole",
  interval: "04:15",
};

const requestTypes = (requests) =>
  requests.map(({ url: requestUrl }) => {
    const params = requestUrl.searchParams;
    return `${params.get("types")}:${params.get("source")}`;
  });

test("falls back to JOOX when NetEase has no playable address", async () => {
  const { handlers, requests, logs } = loadPlugin({
    route: createRoute({
      searches: { "joox:Love Keyshia Cole": [track("j1", "Love", ["Keyshia Cole"])] },
      urls: { "joox:j1:999": url("https://cdn.example.test/joox.flac", 842) },
    }),
  });

  const result = await handlers.musicUrl({
    source: "wy",
    quality: "hi-res",
    musicInfo: neteaseTrack,
  });

  assert.deepEqual(requestTypes(requests), [
    "url:netease",
    "url:netease",
    "url:netease",
    "url:netease",
    "url:netease",
    "search:joox",
    "url:joox",
  ]);
  assert.equal(requests[5].url.searchParams.get("name"), "Love Keyshia Cole");
  assert.equal(requests[6].url.searchParams.get("br"), "999");
  assert.equal(result.url, "https://cdn.example.test/joox.flac");
  assert.equal(result.quality, "lossless");
  assert.ok(logs.some(({ level, args }) => level === "info" && /改用/.test(String(args[0]))));
});

test("never substitutes a Live version for a clean original", async () => {
  const { handlers } = loadPlugin({
    route: createRoute({
      searches: {
        "joox:Love Keyshia Cole": [
          track("j2", "Love (Live)", ["Keyshia Cole"]),
          track("j3", "Love (Remix)", ["Keyshia Cole"]),
        ],
      },
    }),
  });

  await assert.rejects(
    handlers.musicUrl({ source: "wy", quality: "hq", musicInfo: neteaseTrack }),
    (error) => {
      assert.equal(error.code, "GD_TRACK_UNAVAILABLE");
      assert.match(error.message, /GD Studio JOOX/);
      return true;
    },
  );
});

test("lets a versioned original match the clean version on the other platform", async () => {
  const { handlers, requests } = loadPlugin({
    route: createRoute({
      searches: { "joox:Love Keyshia Cole": [track("j1", "Love", ["Keyshia Cole"])] },
      urls: { "joox:j1:320": url("https://cdn.example.test/joox.mp3", 320) },
    }),
  });

  const result = await handlers.musicUrl({
    source: "wy",
    quality: "hq",
    musicInfo: { ...neteaseTrack, name: "Love (Live)" },
  });

  assert.equal(requests.at(-1).url.searchParams.get("id"), "j1");
  assert.equal(result.quality, "hq");
});

test("rejects a candidate with a different artist", async () => {
  const { handlers } = loadPlugin({
    route: createRoute({
      searches: { "joox:Love Keyshia Cole": [track("j1", "Love", ["其他歌手"])] },
      urls: { "joox:j1:320": url("https://cdn.example.test/joox.mp3", 320) },
    }),
  });

  await assert.rejects(
    handlers.musicUrl({ source: "wy", quality: "hq", musicInfo: neteaseTrack }),
    (error) => error.code === "GD_TRACK_UNAVAILABLE",
  );
});

test("keeps failures local when cross-platform fallback is off", async () => {
  const { handlers, requests } = loadPlugin({
    settings: { crossPlatformFallback: false },
    route: createRoute({ searches: { "joox:Love Keyshia Cole": [track("j1", "Love", ["Keyshia Cole"])] } }),
  });

  await assert.rejects(
    handlers.musicUrl({ source: "wy", quality: "hq", musicInfo: neteaseTrack }),
    (error) => error.code === "GD_NO_URL",
  );
  assert.deepEqual(requestTypes(requests), ["url:netease", "url:netease", "url:netease"]);
});

test("cools down a platform that answers 503 and then skips it", async () => {
  let neteaseCalls = 0;
  const { handlers } = loadPlugin({
    route: (requestUrl) => {
      const params = requestUrl.searchParams;
      const type = params.get("types");
      if (type === "url" && params.get("source") === "netease") {
        neteaseCalls += 1;
        return { status: 503, body: "" };
      }
      if (type === "search") {
        return { status: 200, body: [track("j1", "Love", ["Keyshia Cole"])] };
      }
      if (type === "url" && params.get("source") === "joox") {
        return { status: 200, body: url("https://cdn.example.test/joox.mp3", 320) };
      }
      return { status: 200, body: {} };
    },
  });

  const request = { source: "wy", quality: "hq", musicInfo: neteaseTrack };
  const first = await handlers.musicUrl(request);
  const second = await handlers.musicUrl(request);

  assert.equal(first.url, "https://cdn.example.test/joox.mp3");
  assert.equal(second.url, "https://cdn.example.test/joox.mp3");
  assert.equal(neteaseCalls, 1);
});

test("falls back from JOOX to NetEase in the other direction", async () => {
  const { handlers, requests } = loadPlugin({
    route: createRoute({
      searches: { "netease:晴天 周杰倫": [track("w1", "晴天", ["周杰倫"])] },
      urls: { "netease:w1:320": url("https://cdn.example.test/netease.mp3", 320) },
    }),
  });

  const result = await handlers.musicUrl({
    source: "joox",
    quality: "hq",
    musicInfo: { id: "j9", name: "晴天", singer: "周杰倫" },
  });

  assert.equal(result.url, "https://cdn.example.test/netease.mp3");
  assert.deepEqual(requestTypes(requests).slice(-2), ["search:netease", "url:netease"]);
  assert.equal(requests.at(-1).url.searchParams.get("id"), "w1");
});

test("stops probing after a 429 and reuses the cooldown", async () => {
  const { handlers, requests } = loadPlugin({
    route: () => ({
      status: 429,
      headers: { "Retry-After": "30" },
      body: { detail: "Too many requests" },
    }),
  });

  await assert.rejects(
    handlers.musicUrl({ source: "wy", quality: "hq", musicInfo: neteaseTrack }),
    (error) => {
      assert.equal(error.code, "GD_HTTP_429");
      return true;
    },
  );
  assert.equal(requests.length, 1);

  await assert.rejects(
    handlers.musicUrl({ source: "wy", quality: "hq", musicInfo: neteaseTrack }),
    (error) => {
      assert.equal(error.code, "GD_RATE_LIMITED");
      assert.match(error.message, /30 秒/);
      return true;
    },
  );
  assert.equal(requests.length, 1);
});
