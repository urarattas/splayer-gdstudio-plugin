import assert from "node:assert/strict";
import { test } from "node:test";

import { createRoute, loadPlugin, url } from "./plugin-host.js";

const neteaseTrack = {
  songmid: "18902710",
  name: "Love",
  singer: "Keyshia Cole",
  interval: "04:15",
};

test("registers NetEase and JOOX capabilities with the documented actions", () => {
  const { registration, handlers } = loadPlugin();

  assert.deepEqual(Object.keys(registration.sources), ["wy", "joox"]);
  for (const source of Object.values(registration.sources)) {
    assert.deepEqual([...source.actions], ["musicUrl", "musicLyric", "musicPic", "musicSearch"]);
    assert.deepEqual([...source.qualities], ["lq", "sq", "hq", "lossless", "hi-res"]);
  }
  assert.equal(registration.settings[0].key, "crossPlatformFallback");
  for (const action of ["musicUrl", "musicLyric", "musicPic", "musicSearch"]) {
    assert.equal(typeof handlers[action], "function");
  }
});

test("resolves a NetEase track at the requested bitrate and probes the delivery", async () => {
  const { handlers, requests, probes } = loadPlugin({
    route: createRoute({
      urls: { "netease:18902710:999": url("https://cdn.example.test/song.flac", 1650, 52705798) },
    }),
  });

  const result = await handlers.musicUrl({
    source: "wy",
    quality: "hi-res",
    musicInfo: neteaseTrack,
  });

  assert.equal(requests.length, 1);
  const params = requests[0].url.searchParams;
  assert.equal(params.get("types"), "url");
  assert.equal(params.get("source"), "netease");
  assert.equal(params.get("id"), "18902710");
  assert.equal(params.get("br"), "999");
  assert.equal(result.url, "https://cdn.example.test/song.flac");
  assert.equal(result.quality, "hi-res");
  assert.equal(probes.length, 1);
  assert.equal(probes[0].options.headers.Range, "bytes=0-3");
  assert.equal(probes[0].options.responseType, "arraybuffer");
});

test("downgrades the bitrate ladder when the top tiers have no URL", async () => {
  const { handlers, requests } = loadPlugin({
    route: createRoute({ urls: { "netease:18902710:320": url("https://cdn.example.test/song.mp3", 320) } }),
  });

  const result = await handlers.musicUrl({
    source: "wy",
    quality: "hi-res",
    musicInfo: neteaseTrack,
  });

  assert.deepEqual(
    requests.map(({ url: requestUrl }) => requestUrl.searchParams.get("br")),
    ["999", "740", "320"],
  );
  assert.equal(result.quality, "hq");
});

test("reports the served bitrate instead of copying the requested tier", async () => {
  // 实测请求 999 时服务端可能返回 293kbps 的文件，不能标成无损。
  const { handlers } = loadPlugin({
    route: createRoute({
      urls: { "netease:18902710:999": url("https://cdn.example.test/song.flac", 293, 914824) },
    }),
  });

  const result = await handlers.musicUrl({
    source: "wy",
    quality: "hi-res",
    musicInfo: neteaseTrack,
  });

  assert.equal(result.quality, "hq");
});

test("steps to the next tier when the delivery probe rejects the address", async () => {
  const { handlers, requests, probes } = loadPlugin({
    route: createRoute({
      urls: {
        "netease:18902710:999": url("https://cdn.example.test/broken.flac", 842),
        "netease:18902710:740": url("https://cdn.example.test/good.flac", 842),
      },
    }),
    probeResponse: (requestUrl) =>
      requestUrl.pathname.includes("broken")
        ? { status: 403, headers: {}, body: "" }
        : { status: 206, headers: {}, body: new Uint8Array([0x66]) },
  });

  const result = await handlers.musicUrl({
    source: "wy",
    quality: "hi-res",
    musicInfo: neteaseTrack,
  });

  assert.deepEqual(
    requests.map(({ url: requestUrl }) => requestUrl.searchParams.get("br")),
    ["999", "740"],
  );
  assert.equal(probes.length, 2);
  assert.equal(result.url, "https://cdn.example.test/good.flac");
  assert.equal(result.quality, "lossless");
});

test("reuses a resolved URL for the same track", async () => {
  const { handlers, requests, probes } = loadPlugin({
    route: createRoute({
      urls: { "netease:18902710:999": url("https://cdn.example.test/song.flac", 842) },
    }),
  });

  const request = { source: "wy", quality: "hi-res", musicInfo: neteaseTrack };
  const first = await handlers.musicUrl(request);
  const second = await handlers.musicUrl(request);

  assert.equal(requests.length, 1);
  assert.equal(probes.length, 1);
  assert.deepEqual(second, first);
});

test("does not reuse URLs when smartCache is disabled", async () => {
  const { handlers, requests } = loadPlugin({
    settings: { smartCache: false },
    route: createRoute({
      urls: { "netease:18902710:999": url("https://cdn.example.test/song.flac", 842) },
    }),
  });

  const request = { source: "wy", quality: "hi-res", musicInfo: neteaseTrack };
  await handlers.musicUrl(request);
  await handlers.musicUrl(request);

  assert.equal(requests.length, 2);
});

test("shares one in-flight resolution between concurrent calls", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { handlers, requests } = loadPlugin({
    route: (requestUrl) => {
      if (requestUrl.searchParams.get("types") !== "url") {
        return { status: 200, body: [] };
      }
      return gate.then(() => ({
        status: 200,
        body: { url: "https://cdn.example.test/shared.mp3", br: 320, size: 0 },
      }));
    },
  });

  const first = handlers.musicUrl({ source: "wy", quality: "hq", musicInfo: neteaseTrack });
  const second = handlers.musicUrl({ source: "wy", quality: "hq", musicInfo: neteaseTrack });
  release();
  const [left, right] = await Promise.all([first, second]);

  assert.equal(requests.length, 1);
  assert.deepEqual(left, right);
});

test("throws GD_NO_URL after the whole ladder is empty when fallback is off", async () => {
  const { handlers, requests } = loadPlugin({ settings: { crossPlatformFallback: false } });

  await assert.rejects(
    handlers.musicUrl({ source: "wy", quality: "lossless", musicInfo: neteaseTrack }),
    (error) => {
      assert.equal(error.code, "GD_NO_URL");
      assert.match(error.message, /128k/);
      return true;
    },
  );
  assert.equal(requests.length, 4);
});

test("returns lyric and translation, using the lyric id from the candidate", async () => {
  const { handlers, requests } = loadPlugin({
    route: createRoute({
      lyrics: {
        "netease:lyric-42": { lyric: "[00:01.00]hello", tlyric: "[00:01.00]你好" },
      },
    }),
  });

  const result = await handlers.musicLyric({
    source: "wy",
    musicInfo: { ...neteaseTrack, lyricId: "lyric-42" },
  });

  const params = requests[0].url.searchParams;
  assert.equal(params.get("types"), "lyric");
  assert.equal(params.get("source"), "netease");
  assert.equal(params.get("id"), "lyric-42");
  assert.equal(result.lyric, "[00:01.00]hello");
  assert.equal(result.tlyric, "[00:01.00]你好");
});

test("treats the NetEase placeholder lyric as empty", async () => {
  const { handlers } = loadPlugin({
    route: createRoute({ lyrics: { "netease:18902710": { lyric: "[00:00.00]暂无歌词", tlyric: "" } } }),
  });

  const result = await handlers.musicLyric({ source: "wy", musicInfo: neteaseTrack });
  assert.equal(result.lyric, "");
});

test("returns a cover from the pic endpoint and honours a supplied cover", async () => {
  const { handlers, requests } = loadPlugin({
    route: createRoute({
      pics: { "netease:pic-99": { url: "https://img.example.test/99.jpg" } },
    }),
  });

  const fetched = await handlers.musicPic({
    source: "wy",
    musicInfo: { ...neteaseTrack, picId: "pic-99" },
  });
  assert.equal(fetched.url, "https://img.example.test/99.jpg");
  assert.equal(requests[0].url.searchParams.get("size"), "500");

  const supplied = await handlers.musicPic({
    source: "wy",
    musicInfo: { ...neteaseTrack, img: "https://img.example.test/from-host.jpg" },
  });
  assert.equal(supplied.url, "https://img.example.test/from-host.jpg");
  assert.equal(requests.length, 1);
});

test("skips lyric and cover requests when metadataFallback is off", async () => {
  const { handlers, requests } = loadPlugin({ settings: { metadataFallback: false } });

  const lyric = await handlers.musicLyric({ source: "wy", musicInfo: neteaseTrack });
  const cover = await handlers.musicPic({ source: "wy", musicInfo: neteaseTrack });

  assert.deepEqual(lyric, { lyric: "" });
  assert.deepEqual(cover, { url: "" });
  assert.equal(requests.length, 0);
});

test("rejects unsupported sources and missing track ids", async () => {
  const { handlers } = loadPlugin();

  await assert.rejects(
    handlers.musicUrl({ source: "tx", quality: "hq", musicInfo: { songmid: "1" } }),
    (error) => error.code === "GD_SOURCE_UNSUPPORTED",
  );
  await assert.rejects(
    handlers.musicUrl({ source: "wy", quality: "hq", musicInfo: { name: "没有 ID" } }),
    (error) => error.code === "GD_TRACK_INVALID",
  );
});

test("resolves a JOOX catalog track through its own source key", async () => {
  const id = "MX14hTaB09S4XtuczK40Rg==";
  const { handlers, requests } = loadPlugin({
    route: createRoute({ urls: { [`joox:${id}:320`]: url("https://cdn.example.test/joox.mp3", 320) } }),
  });

  const result = await handlers.musicUrl({
    source: "joox",
    quality: "hq",
    musicInfo: { id, name: "love.", singer: "wave to earth" },
  });

  const params = requests[0].url.searchParams;
  assert.equal(params.get("source"), "joox");
  assert.equal(params.get("id"), id);
  assert.equal(params.get("br"), "320");
  assert.equal(result.quality, "hq");
});

test("runtime adapter reports the four registered actions", () => {
  const { createRuntimeAdapter } = loadPlugin();
  const bound = {};
  const registered = {};
  const runtime = {
    register(args) {
      Object.assign(registered, args);
    },
    on(action, handler) {
      bound[action] = handler;
    },
  };

  const adapter = createRuntimeAdapter(runtime);
  adapter.register({ sources: { wy: { name: "x", actions: ["musicUrl"] } } });
  adapter.bind({
    musicUrl: () => "url",
    musicLyric: () => "lyric",
    musicPic: () => "pic",
    musicSearch: () => "search",
  });

  assert.deepEqual(Object.keys(registered), ["sources"]);
  assert.deepEqual(Object.keys(bound).sort(), ["musicLyric", "musicPic", "musicSearch", "musicUrl"]);
});
