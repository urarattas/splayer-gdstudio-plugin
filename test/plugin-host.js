import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const pluginSource = await readFile(
  resolve(projectRoot, "src", "plugin.js"),
  "utf8",
);

/**
 * 以真实的 SPlayer 插件契约加载 `src/plugin.js`：只注入文档里列出的全局对象，
 * 网络由 `route` 决定，交付体检单独记账。
 */
export const loadPlugin = ({
  settings: settingOverrides = {},
  sourceText = pluginSource,
  route,
  probeResponse,
  now = () => Date.now(),
} = {}) => {
  const registration = {};
  const handlers = {};
  const requests = [];
  const probes = [];
  const logs = [];
  const settings = { ...settingOverrides };

  // 真实的宿主通过 IPC 把处理器结果序列化后再交给界面；这里做同样的转换，
  // 测试拿到的就是普通对象，而不是另一个 vm realm 的对象。
  const cloneResult = (value) =>
    value === undefined ? value : JSON.parse(JSON.stringify(value));

  const defaultRoute = (url) => {
    const params = url.searchParams;
    switch (params.get("types")) {
      case "search":
        return { status: 200, body: [] };
      case "url":
        return { status: 200, body: { url: "", br: -1, size: 0 } };
      case "lyric":
        return { status: 200, body: { lyric: "[00:00.00]测试歌词", tlyric: "" } };
      case "pic":
        return { status: 200, body: { url: "https://img.example.test/cover.jpg" } };
      default:
        return { status: 400, body: { detail: "unknown types" } };
    }
  };

  const splayer = {
    register(args) {
      Object.assign(registration, args);
    },
    on(action, handler) {
      handlers[action] = async (request) => cloneResult(await handler(request));
    },
    getSetting(key) {
      return settings[key];
    },
    async request(rawUrl, options) {
      const url = new URL(rawUrl);
      const isProbe = Boolean(options?.headers?.Range || options?.headers?.range);
      if (isProbe) {
        probes.push({ url, options });
        if (probeResponse === undefined) {
          return { status: 206, headers: {}, body: new Uint8Array([0x66, 0x4c]) };
        }
        return typeof probeResponse === "function"
          ? probeResponse(url, options)
          : probeResponse;
      }
      requests.push({ url, options });
      const result = (route ?? defaultRoute)(url, options);
      return typeof result?.then === "function" ? await result : result;
    },
    log: Object.fromEntries(
      ["debug", "info", "warn", "error"].map((level) => [
        level,
        (...args) => logs.push({ level, args }),
      ]),
    ),
  };

  const context = {
    splayer,
    URL,
    URLSearchParams,
    Promise,
    console,
    setTimeout,
    clearTimeout,
    TextEncoder,
    TextDecoder,
    Date: class extends Date {
      static now() {
        return now();
      }
    },
  };

  vm.runInNewContext(
    `${sourceText}
;globalThis.__core = resolutionImplementation;
;globalThis.__policies = SOURCE_POLICIES;
;globalThis.__qualities = QUALITY_NAMES;
;globalThis.__bitrates = BITRATE_BY_QUALITY;
;globalThis.__createRuntimeAdapter = createRuntimeAdapter;`,
    context,
  );

  return {
    registration,
    handlers,
    requests,
    probes,
    logs,
    settings,
    setSetting(key, value) {
      settings[key] = value;
    },
    core: context.__core,
    policies: context.__policies,
    qualities: context.__qualities,
    bitrates: context.__bitrates,
    createRuntimeAdapter: context.__createRuntimeAdapter,
  };
};

/** 构造按 `types` + 关键字分发的假 GD Studio 响应。 */
export const createRoute = ({ urls = {}, searches = {}, lyrics = {}, pics = {} } = {}) =>
  (url) => {
    const params = url.searchParams;
    const type = params.get("types");
    const source = params.get("source");

    if (type === "search") {
      const key = `${source}:${params.get("name")}`;
      const hit = searches[key];
      if (Array.isArray(hit)) return { status: 200, body: hit };
      if (typeof hit === "function") return hit(url);
      return { status: 200, body: [] };
    }

    if (type === "url") {
      const key = `${source}:${params.get("id")}:${params.get("br")}`;
      const hit = urls[key];
      if (hit === undefined) return { status: 200, body: { url: "", br: -1, size: 0 } };
      if (typeof hit === "function") return hit(url);
      if (typeof hit === "string") return { status: 200, body: { url: hit, br: 320, size: 0 } };
      return { status: 200, body: hit };
    }

    if (type === "lyric") {
      const hit = lyrics[`${source}:${params.get("id")}`];
      if (hit === undefined) return { status: 200, body: { lyric: "[00:00.00]默认歌词", tlyric: "" } };
      return typeof hit === "function" ? hit(url) : { status: 200, body: hit };
    }

    if (type === "pic") {
      const hit = pics[`${source}:${params.get("id")}`];
      if (hit === undefined) return { status: 200, body: { url: "https://img.example.test/cover.jpg" } };
      return typeof hit === "function" ? hit(url) : { status: 200, body: hit };
    }

    return { status: 400, body: { detail: "unknown types" } };
  };

/** 搜到的歌（GD Studio 搜索项的原始字段）。 */
export const track = (id, name, artist, album = "测试专辑", extra = {}) => ({
  id: String(id),
  name,
  artist: Array.isArray(artist) ? artist : [artist],
  album,
  pic_id: `pic-${id}`,
  lyric_id: `lyric-${id}`,
  source: "netease",
  ...extra,
});

export const url = (value, br = 320, size = 0) => ({ url: value, br, size });
