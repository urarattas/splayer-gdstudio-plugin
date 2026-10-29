import assert from "node:assert/strict";
import { test } from "node:test";

import { createRoute, loadPlugin, track } from "./plugin-host.js";

const jooxCatalog = Array.from({ length: 25 }, (_, index) =>
  track(`j${index}`, `歌曲 ${index}`, index % 2 ? ["歌手甲", "歌手乙"] : "歌手甲"),
);

test("paginates the JOOX catalog without duplicating entries", async () => {
  const { handlers, requests } = loadPlugin({
    route: createRoute({ searches: { "joox:晴天": jooxCatalog } }),
  });

  const first = await handlers.musicSearch({ source: "joox", keyword: "晴天", page: 1, limit: 10 });
  assert.deepEqual(first.list.map((item) => item.id), Array.from({ length: 10 }, (_, i) => `j${i}`));
  assert.equal(first.hasMore, true);
  assert.equal(requests[0].url.searchParams.get("count"), "10");

  const second = await handlers.musicSearch({ source: "joox", keyword: "晴天", page: 2, limit: 10 });
  assert.deepEqual(second.list.map((item) => item.id), Array.from({ length: 10 }, (_, i) => `j${i + 10}`));
  assert.equal(second.hasMore, true);
  assert.equal(requests[1].url.searchParams.get("count"), "20");

  const third = await handlers.musicSearch({ source: "joox", keyword: "晴天", page: 3, limit: 10 });
  assert.deepEqual(third.list.map((item) => item.id), ["j20", "j21", "j22", "j23", "j24"]);
  assert.equal(third.hasMore, false);
});

test("maps artists, albums, cover and lyric ids into host candidates", async () => {
  const { handlers } = loadPlugin({
    route: createRoute({ searches: { "joox:晴天": [jooxCatalog[1]] } }),
  });

  const { list } = await handlers.musicSearch({ source: "joox", keyword: "晴天", limit: 10 });
  assert.equal(list.length, 1);
  assert.deepEqual(list[0], {
    id: "j1",
    name: "歌曲 1",
    singer: "歌手甲/歌手乙",
    album: "测试专辑",
    picId: "pic-j1",
    lyricId: "lyric-j1",
  });
  assert.equal(list[0].url, undefined);
});

test("limits the host page size and truncates long keywords", async () => {
  const { handlers, requests } = loadPlugin({
    route: createRoute({ searches: { [`joox:${"长".repeat(60)}`]: jooxCatalog } }),
  });

  await handlers.musicSearch({ source: "joox", keyword: "长".repeat(200), page: 1, limit: 500 });
  const params = requests[0].url.searchParams;
  assert.equal(params.get("name"), "长".repeat(60));
  assert.equal(params.get("count"), "50");
});

test("serves page one NetEase metadata search with cover ids for the host matcher", async () => {
  const { handlers, requests } = loadPlugin({
    route: (requestUrl) => {
      const params = requestUrl.searchParams;
      if (params.get("types") === "search") {
        return {
          status: 200,
          body: [track("1", "Love", "Keyshia Cole"), track("2", "Love (Live)", "Keyshia Cole")],
        };
      }
      return { status: 200, body: {} };
    },
  });

  const { list } = await handlers.musicSearch({
    source: "wy",
    keyword: "Love Keyshia Cole",
    page: 1,
    limit: 20,
  });

  assert.equal(requests[0].url.searchParams.get("name"), "Love Keyshia Cole");
  assert.equal(requests[0].url.searchParams.get("count"), "10");
  assert.deepEqual(list.map((item) => item.id), ["1", "2"]);
  assert.equal(list[0].picId, "pic-1");
  assert.equal(list[0].lyricId, "lyric-1");
});

test("ignores metadata search after page one when the source is built in", async () => {
  const { handlers, requests } = loadPlugin({ route: createRoute() });

  const result = await handlers.musicSearch({ source: "wy", keyword: "Love", page: 2, limit: 20 });
  assert.deepEqual(result, { list: [] });
  assert.equal(requests.length, 0);
});

test("returns no candidates for an empty keyword without sending a request", async () => {
  const { handlers, requests } = loadPlugin({ route: createRoute() });

  assert.deepEqual(await handlers.musicSearch({ source: "joox", keyword: "   " }), { list: [] });
  assert.equal(requests.length, 0);
});

test("surfaces the GD Studio error detail for a failed search", async () => {
  const { handlers } = loadPlugin({
    route: () => ({ status: 400, body: { detail: "Value of `source` is not supported." } }),
  });

  await assert.rejects(handlers.musicSearch({ source: "joox", keyword: "晴天" }), (error) => {
    assert.equal(error.code, "GD_HTTP_400");
    assert.match(error.message, /Value of `source` is not supported/);
    return true;
  });
});

test("rejects a search response that is neither an array nor a list object", async () => {
  const { handlers } = loadPlugin({ route: () => ({ status: 200, body: { detail: "oops" } }) });

  await assert.rejects(handlers.musicSearch({ source: "joox", keyword: "晴天" }), (error) => {
    assert.equal(error.code, "GD_INVALID_RESPONSE");
    return true;
  });
});

test("reuses cached search results across identical queries", async () => {
  const { handlers, requests } = loadPlugin({
    route: createRoute({ searches: { "joox:晴天": jooxCatalog.slice(0, 3) } }),
  });

  await handlers.musicSearch({ source: "joox", keyword: "晴天", page: 1, limit: 10 });
  await handlers.musicSearch({ source: "joox", keyword: "晴天", page: 1, limit: 10 });

  assert.equal(requests.length, 1);
});
