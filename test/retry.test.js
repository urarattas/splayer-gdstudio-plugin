import assert from "node:assert/strict";
import { test } from "node:test";

import { createRoute, loadPlugin, url } from "./plugin-host.js";

const neteaseTrack = {
  songmid: "18902710",
  name: "Love",
  singer: "Keyshia Cole",
  interval: "04:15",
};

test("retries a transient 503 and succeeds", async () => {
  let attempts = 0;
  const { handlers, requests, logs } = loadPlugin({
    fastTimers: true,
    route: (requestUrl) => {
      if (requestUrl.searchParams.get("types") !== "url") {
        return { status: 200, body: [] };
      }
      attempts += 1;
      if (attempts === 1) return { status: 503, body: "<html>503</html>" };
      return {
        status: 200,
        body: { url: "https://cdn.example.test/retried.flac", br: 842, size: 0 },
      };
    },
  });

  const result = await handlers.musicUrl({
    source: "wy",
    quality: "hi-res",
    musicInfo: neteaseTrack,
  });

  assert.equal(attempts, 2);
  assert.equal(requests.length, 2);
  assert.equal(result.url, "https://cdn.example.test/retried.flac");
  assert.equal(result.quality, "lossless");
  assert.ok(
    logs.some(({ level, args }) => level === "warn" && /重试/.test(String(args[0]))),
    "should log the retry",
  );
});

test("gives up after six attempts and reports the retry count", async () => {
  const { handlers, requests } = loadPlugin({
    fastTimers: true,
    settings: { crossPlatformFallback: false },
    route: () => ({ status: 503, body: "<html>503</html>" }),
  });

  await assert.rejects(
    handlers.musicUrl({ source: "wy", quality: "hq", musicInfo: neteaseTrack }),
    (error) => {
      assert.equal(error.code, "GD_HTTP_503");
      assert.match(error.message, /接口暂时不可用/);
      assert.match(error.message, /已重试 5 次/);
      assert.match(error.message, /自动恢复/);
      return true;
    },
  );
  assert.equal(requests.length, 6);
});

test("breaker turns retries into a single probe during an outage", async () => {
  const { handlers, requests } = loadPlugin({
    fastTimers: true,
    settings: { crossPlatformFallback: false, smartCache: false },
    route: () => ({ status: 503, body: "<html>503</html>" }),
  });

  // 第一首歌重试 6 次、累计 3 次以上 5xx，触发熔断。
  await assert.rejects(
    handlers.musicUrl({ source: "wy", quality: "hq", musicInfo: neteaseTrack }),
    (error) => error.code === "GD_HTTP_503",
  );
  const afterFirst = requests.length;
  assert.equal(afterFirst, 6);

  // 熔断期内只探测一次，不再反复重试。
  await assert.rejects(
    handlers.musicUrl({
      source: "wy",
      quality: "hq",
      musicInfo: { songmid: "other", name: "另一首", singer: "歌手" },
    }),
    (error) => {
      assert.equal(error.code, "GD_HTTP_503");
      assert.match(error.message, /自动恢复/);
      return true;
    },
  );
  assert.equal(requests.length, afterFirst + 1);
});

test("retries a transient network failure", async () => {
  let attempts = 0;
  const { handlers } = loadPlugin({
    fastTimers: true,
    route: (requestUrl) => {
      if (requestUrl.searchParams.get("types") !== "url") {
        return { status: 200, body: [] };
      }
      attempts += 1;
      if (attempts === 1) return Promise.reject(new Error("read ECONNRESET"));
      return { status: 200, body: url("https://cdn.example.test/network.mp3", 320) };
    },
  });

  const result = await handlers.musicUrl({
    source: "wy",
    quality: "hq",
    musicInfo: neteaseTrack,
  });

  assert.equal(attempts, 2);
  assert.equal(result.url, "https://cdn.example.test/network.mp3");
});

test("does not retry a 429 rate-limit response", async () => {
  const { handlers, requests } = loadPlugin({
    fastTimers: true,
    route: () => ({
      status: 429,
      headers: { "Retry-After": "30" },
      body: { detail: "Too many requests" },
    }),
  });

  await assert.rejects(
    handlers.musicUrl({ source: "wy", quality: "hq", musicInfo: neteaseTrack }),
    (error) => error.code === "GD_HTTP_429",
  );
  assert.equal(requests.length, 1);
});
