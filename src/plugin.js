/**
 * @name        GD Studio 音源
 * @id          gdstudio.splayer-source
 * @version     1.2.0
 * @description 官方音源拿不到时，用 GD Studio 接管网易云播放地址；歌词与封面保持官方，逐档解析音质并交付体检
 * @author      splayer-gdstudio-plugin
 * @type        source
 * @grant       network
 * @apiLevel    5
 * @changelog   移除独立曲库与 GD 歌词/封面，只接管官方拿不到的播放地址（默认 hi-res）
 */

const API_BASE_URL = "https://music-api.gdstudio.xyz/api.php";
const REQUEST_TIMEOUT = 15_000;
// SPlayer 给 musicUrl 的时限是 20 秒，留两秒给宿主做清理。
const RESOLUTION_TIME_BUDGET = 18_000;
const CROSS_PLATFORM_TIME_BUDGET = 8_000;
const CROSS_PLATFORM_REQUEST_BUDGET = 4;
const CROSS_PLATFORM_MAX_CANDIDATES = 2;
const SEARCH_RESULT_LIMIT = 10;
// GD Studio 的关键词直接进 URL 参数；统一截断，避免过长请求被拒。
const SEARCH_KEYWORD_MAX_LENGTH = 60;
const CACHE_LIMIT = 128;
const CACHE_TTL = 5 * 60_000;
// 播放地址没有明确的过期时间，只做很短的复用，避免把过期链接留给下一次播放。
const URL_CACHE_TTL = 90_000;
const UNAVAILABLE_TTL = 60_000;
// 整条音质阶梯都没有地址，说明是版权问题而不是瞬时抖动，短期内同曲直接跳跨平台。
const TRACK_UNAVAILABLE_TTL = 5 * 60_000;
const DURATION_TOLERANCE_SECONDS = 20;
// GD Studio 限流为 5 分钟内不超过 50 次请求；命中 429 后按 Retry-After 进入冷却。
const RATE_LIMIT_COOLDOWN = 60_000;
const MAX_RATE_LIMIT_COOLDOWN = 15 * 60_000;
// 502/503/504 说明上游平台通道故障；冷却该平台，避免继续白打请求。
const CHANNEL_COOLDOWN = 2 * 60_000;
const MAX_CHANNEL_COOLDOWN = 15 * 60_000;
// 交付体检：返回地址前只取前几个字节确认真的能拉流（CDN 请求，不消耗 GD Studio 额度）。
const PROBE_TIMEOUT = 4_000;
const PROBE_RANGE = "bytes=0-3";

const NO_URL_ERROR = "GD_NO_URL";
const DELIVERY_UNUSABLE_ERROR = "GD_DELIVERY_UNUSABLE";
const INVALID_RESPONSE = "GD_INVALID_RESPONSE";
const RATE_LIMIT_ERROR = "GD_RATE_LIMITED";
const CHANNEL_COOLDOWN_ERROR = "GD_CHANNEL_COOLDOWN";
const NETWORK_ERROR = "GD_NETWORK_ERROR";
const REQUEST_TIMEOUT_ERROR = "GD_REQUEST_TIMEOUT";
const RESOLUTION_TIMEOUT_ERROR = "GD_RESOLUTION_TIMEOUT";
const CROSS_PLATFORM_LIMIT_ERROR = "GD_CROSS_PLATFORM_LIMIT";
const CROSS_PLATFORM_UNAVAILABLE_ERROR = "GD_CROSS_PLATFORM_UNAVAILABLE";
const TRACK_UNAVAILABLE_ERROR = "GD_TRACK_UNAVAILABLE";

// 只有这些错误才说明"地址打不开"；宿主不支持体检选项等其它错误按无法判定处理，不降级。
const UNREACHABLE_PROBE_CODES = new Set([
  REQUEST_TIMEOUT_ERROR,
  "PLUGIN_REQUEST_TIMEOUT",
  "PLUGIN_NETWORK_ERROR",
  "REQUEST_TIMEOUT",
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "ENOTFOUND",
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
]);

const QUALITY_NAMES = ["lq", "sq", "hq", "lossless", "hi-res"];
// GD Studio 的 br 档位：740 为 16bit 无损，999 为 24bit 无损，其余为有损码率。
const BITRATE_BY_QUALITY = {
  lq: 128,
  sq: 192,
  hq: 320,
  lossless: 740,
  "hi-res": 999,
};
const QUALITY_BY_BITRATE = Object.fromEntries(
  Object.entries(BITRATE_BY_QUALITY).map(([quality, bitrate]) => [bitrate, quality]),
);
// 无损档体积很大（实测单曲 27–52MB），"可播放优先"把它们排到阶梯最后。
const LOSSLESS_BITRATES = new Set([740, 999]);
// Logical downgrade ladder shared by both platforms: hi-res → lossless → hq → sq → lq.
const QUALITY_FALLBACKS = Object.fromEntries(
  QUALITY_NAMES.map((quality, index) => [
    quality,
    QUALITY_NAMES.slice(0, index + 1).reverse(),
  ]),
);

const SOURCE_POLICIES = {
  // SPlayer 内置来源：只补播放地址，歌词与封面保持官方。
  wy: {
    name: "GD Studio 网易云",
    apiSource: "netease",
    identity: { idFields: ["id", "songId", "songmid"] },
    crossPlatform: ["joox"],
  },
  // 只作为跨平台兜底目标使用，不在搜索页注册。
  joox: {
    name: "GD Studio JOOX",
    apiSource: "joox",
    identity: { idFields: ["id", "songmid", "songId"] },
    crossPlatform: ["wy"],
  },
};

// 插件自己的音质选择：默认 hi-res，不再受播放器音质档位限制。
const QUALITY_SETTING = "quality";
const DEFAULT_PLUGIN_QUALITY = "hi-res";

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const textOrEmpty = (value) => (typeof value === "string" ? value.trim() : "");

const pluginError = (code, message) => {
  const error = new Error(message);
  error.code = code;
  return error;
};

const getSourcePolicy = (source) => {
  const policy = SOURCE_POLICIES[source];
  if (!policy) {
    throw pluginError(
      "GD_SOURCE_UNSUPPORTED",
      `不支持的 SPlayer 音源：${String(source)}。GD Studio 音源只接管网易云（wy）。`,
    );
  }
  return policy;
};

const getMusicId = (source, musicInfo) => {
  const policy = getSourcePolicy(source);
  if (!isRecord(musicInfo)) {
    throw pluginError("GD_TRACK_INVALID", "SPlayer 未提供有效的歌曲信息。");
  }

  for (const key of policy.identity.idFields) {
    const value = musicInfo[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }

  throw pluginError("GD_TRACK_INVALID", "歌曲缺少平台 ID，无法请求 GD Studio。");
};

const ARTIST_SEPARATOR = /[/、,，&]/;
const TITLE_BRACKET_PATTERN = /[（(\[【][^）)\]】]{0,40}[）)\]】]/g;
const TITLE_TRAILING_VARIANT_PATTERN =
  /[\s\-–—_]+(?:live|remaster(?:ed)?|version|ver\.?|instrumental|inst\.?|off\s*vocal|伴奏|现场|演唱会).*$/i;

/**
 * 去掉标题里的版本标记（括号段、"- Live" 这类后缀）。
 * 用于跨平台搜索关键词，以及"原曲自带版本标记、候选是干净标题"时的宽松匹配。
 */
const stripTitleVariant = (value) => {
  const original = textOrEmpty(value);
  const stripped = original
    .replace(TITLE_BRACKET_PATTERN, " ")
    .replace(TITLE_TRAILING_VARIANT_PATTERN, "")
    .replace(/\s+/g, " ")
    .trim();
  // 整个标题都是版本标记时（例如 "(Live)"）退回原值，避免把所有候选都视为同一首。
  return stripped || original;
};

const normaliseText = (value) =>
  String(value ?? "")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");

const splitArtists = (value) =>
  String(value ?? "").split(ARTIST_SEPARATOR).map(normaliseText).filter(Boolean);

const exactlyEqual = (a, b) => Boolean(a) && Boolean(b) && a === b;

const parseDurationSeconds = (value) => {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return 0;
    // Values this large can only be milliseconds.
    return value >= 36_000 ? value / 1000 : value;
  }
  const text = textOrEmpty(value);
  const clock = /^(\d{1,3}):(\d{2})$/.exec(text);
  if (clock) return Number(clock[1]) * 60 + Number(clock[2]);
  return parseDurationSeconds(Number(text));
};

/** 只有"原曲自带版本标记、候选是干净标题"时才允许宽松匹配。 */
const isVariantFallback = (wantedTitle, candidateTitle) => {
  const wanted = textOrEmpty(wantedTitle);
  const candidate = textOrEmpty(candidateTitle);
  const wantedBase = stripTitleVariant(wanted);
  const candidateBase = stripTitleVariant(candidate);
  // 原曲本身没有版本标记，说明它就是规范版本，不接受别的版本顶替。
  if (normaliseText(wantedBase) === normaliseText(wanted)) return false;
  // 候选自己也带版本标记时必须走精确匹配，否则会拿另一个变体冒充。
  if (normaliseText(candidateBase) !== normaliseText(candidate)) return false;
  return exactlyEqual(normaliseText(wantedBase), normaliseText(candidateBase));
};

/** 0 = different song, 2 = exact normalised title, 1 = relaxed title match. */
const matchScore = (track, candidate) => {
  if (!isRecord(candidate)) return 0;
  const wantedName = normaliseText(track.name);
  const candidateName = normaliseText(candidate.name);
  const exact = exactlyEqual(wantedName, candidateName);
  const relaxed = !exact && isVariantFallback(track.name, candidate.name);
  if (!exact && !relaxed) return 0;

  const wantedArtists = splitArtists(track.singer);
  const candidateArtists = splitArtists(candidate.singer);
  if (
    wantedArtists.length &&
    (!candidateArtists.length ||
      !wantedArtists.some((artist) =>
        candidateArtists.some((other) => exactlyEqual(artist, other)),
      ))
  ) {
    return 0;
  }

  const wantedSeconds = parseDurationSeconds(track.interval);
  const candidateSeconds = parseDurationSeconds(candidate.interval);
  if (
    wantedSeconds &&
    candidateSeconds &&
    Math.abs(wantedSeconds - candidateSeconds) > DURATION_TOLERANCE_SECONDS
  ) {
    return 0;
  }

  return exact ? 2 : 1;
};

/**
 * 搜索关键词：去掉版本标记的标题 + 第一位歌手。
 * GD Studio 的搜索接口按曲目名、歌手名、专辑名匹配，带版本后缀会显著降低命中率。
 */
const buildSearchKeyword = (track) => {
  const primaryArtist = textOrEmpty(track.singer).split(ARTIST_SEPARATOR)[0].trim();
  const title = stripTitleVariant(track.name).slice(0, SEARCH_KEYWORD_MAX_LENGTH).trim();
  const keyword = [title, primaryArtist].filter(Boolean).join(" ");
  return keyword.length > SEARCH_KEYWORD_MAX_LENGTH ? title || keyword.slice(0, SEARCH_KEYWORD_MAX_LENGTH) : keyword;
};

/** Metadata SPlayer attaches to musicInfo; only used for cross-platform matching. */
const getTrackDescriptor = (musicInfo) => ({
  name: textOrEmpty(musicInfo?.name),
  singer: textOrEmpty(musicInfo?.singer),
  interval: textOrEmpty(musicInfo?.interval),
});

const joinArtists = (value) => {
  if (Array.isArray(value)) {
    return value.map(textOrEmpty).filter(Boolean).join("/");
  }
  return textOrEmpty(value);
};

/**
 * GD Studio 的搜索项形如
 * { id, name, artist: string[], album, pic_id, lyric_id, source }，没有时长字段。
 * pic_id / lyric_id 与 id 不一定相同，随候选一起保存，歌词和封面才能命中同一条记录。
 */
const normaliseCandidate = (raw) => {
  if (!isRecord(raw)) return null;
  const id = textOrEmpty(raw.id) || textOrEmpty(raw.url_id);
  const name = textOrEmpty(raw.name);
  if (!id || !name) return null;
  const seconds = parseDurationSeconds(raw.interval ?? raw.duration);
  return {
    id,
    name,
    singer: joinArtists(raw.artist ?? raw.singer),
    album: textOrEmpty(raw.album),
    ...(seconds > 0 ? { interval: seconds } : {}),
  };
};

const normaliseCandidates = (list) =>
  (Array.isArray(list) ? list : [])
    .map(normaliseCandidate)
    .filter((candidate) => candidate !== null);

const createResolutionCore = () => {
  let session;

  const enabledSetting = (key, fallback) => {
    const value = splayer.getSetting(key);
    return value === undefined || value === null || value === "" ? fallback : value === true;
  };

  // 插件音质选择独立于播放器设置：默认 hi-res，可选 auto 跟随播放器。
  const readQualitySetting = () => {
    const value = splayer.getSetting(QUALITY_SETTING);
    const text = typeof value === "string" ? value.trim() : "";
    if (text === "auto") return "auto";
    return QUALITY_NAMES.includes(text) ? text : DEFAULT_PLUGIN_QUALITY;
  };

  // 新配置拥有一套新缓存。旧的在途请求无法写进新会话。
  const getSession = () => {
    const config = {
      quality: readQualitySetting(),
      smartCache: enabledSetting("smartCache", true),
      economyMode: enabledSetting("economyMode", false),
      crossPlatformFallback: enabledSetting("crossPlatformFallback", true),
      playableFirst: enabledSetting("playableFirst", false),
      verifyDelivery: enabledSetting("verifyDelivery", true),
    };
    const signature = JSON.stringify(config);
    if (session?.signature !== signature) {
      session = {
        config,
        signature,
        responses: new Map(),
        pending: new Map(),
        channelCooldowns: new Map(),
        unavailableTracks: new Map(),
        probes: new Map(),
        rateLimitUntil: 0,
      };
    }
    return session;
  };

  const readCache = (map, key) => {
    const entry = map.get(key);
    if (!entry) return undefined;
    if (entry.until <= Date.now()) {
      map.delete(key);
      return undefined;
    }
    return entry.value;
  };

  const writeCache = (map, key, value, until) => {
    if (until <= Date.now()) return;
    map.delete(key);
    while (map.size >= CACHE_LIMIT) map.delete(map.keys().next().value);
    map.set(key, { value, until });
  };

  const sharePending = async (state, map, key, operation) => {
    if (!state.config.smartCache) return operation();
    const existing = map.get(key);
    if (existing) return existing;
    if (map.size >= CACHE_LIMIT) return operation();
    const pending = Promise.resolve().then(operation);
    map.set(key, pending);
    try {
      return await pending;
    } finally {
      if (map.get(key) === pending) map.delete(key);
    }
  };

  const remainingSeconds = (until) =>
    Math.max(0, Math.ceil((Number(until) - Date.now()) / 1000));

  const assertRateLimit = (state) => {
    const remaining = remainingSeconds(state.rateLimitUntil);
    if (remaining > 0) {
      throw pluginError(
        RATE_LIMIT_ERROR,
        `GD Studio 请求受限：请在 ${remaining} 秒后再试。`,
      );
    }
  };

  const noteRateLimit = (state, error) => {
    if (Number(error?.status) !== 429) return;
    const retryAfter = Number(error?.retryAfterSeconds);
    const seconds =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter
        : RATE_LIMIT_COOLDOWN / 1000;
    const until = Date.now() + Math.min(seconds * 1000, MAX_RATE_LIMIT_COOLDOWN);
    state.rateLimitUntil = Math.max(state.rateLimitUntil, until);
  };

  /** 502/503/504 由 GD Studio 的上游平台通道返回；此时继续探测只会白打请求。 */
  const isUpstreamUnavailableError = (error) =>
    [502, 503, 504].includes(Number(error?.status));

  const coolingDown = (map, source) => {
    const until = map.get(source);
    if (!until) return 0;
    const remaining = remainingSeconds(until);
    if (remaining <= 0) {
      map.delete(source);
      return 0;
    }
    return remaining;
  };

  const cooldownMillis = (error, fallback) => {
    const retryAfter = Number(error?.retryAfterSeconds);
    return Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(retryAfter * 1000, MAX_CHANNEL_COOLDOWN)
      : fallback;
  };

  const noteChannelFailure = (state, source, error) => {
    if (!isUpstreamUnavailableError(error)) return;
    state.channelCooldowns.set(source, Date.now() + cooldownMillis(error, CHANNEL_COOLDOWN));
  };

  const trackUnavailableKey = (source, id) => `${source}:${String(id)}`;

  const readUnavailableTrack = (state, source, id) => {
    const key = trackUnavailableKey(source, id);
    const entry = state.unavailableTracks.get(key);
    if (!entry) return undefined;
    if (entry.until <= Date.now()) {
      state.unavailableTracks.delete(key);
      return undefined;
    }
    return entry.error;
  };

  const rememberUnavailableTrack = (state, source, id, error) => {
    if (!state.config.smartCache) return;
    const key = trackUnavailableKey(source, id);
    state.unavailableTracks.delete(key);
    while (state.unavailableTracks.size >= CACHE_LIMIT) {
      state.unavailableTracks.delete(state.unavailableTracks.keys().next().value);
    }
    state.unavailableTracks.set(key, {
      error,
      until: Date.now() + TRACK_UNAVAILABLE_TTL,
    });
  };

  const buildApiUrl = (params) => {
    const url = new URL(API_BASE_URL);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  };

  const requestKey = (params) =>
    JSON.stringify(
      Object.entries(params).sort(([left], [right]) => left.localeCompare(right)),
    );

  const assertCurrentSession = (state) => {
    if (state !== getSession()) {
      throw pluginError("GD_CONFIG_CHANGED", "GD Studio 音源配置已变化，请重新播放。");
    }
  };

  const getHeader = (headers, name) => {
    if (!isRecord(headers)) return "";
    const wanted = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === wanted && typeof value === "string") return value;
    }
    return "";
  };

  const getBodyMessage = (body) => {
    if (!isRecord(body)) return "";
    for (const key of ["detail", "message", "msg", "error"]) {
      const value = body[key];
      if (typeof value === "string" && value.trim()) return value.trim();
      if (isRecord(value) && typeof value.message === "string" && value.message.trim()) {
        return value.message.trim();
      }
    }
    return "";
  };

  const throwHttpError = (response) => {
    const status = Number(response?.status) || 0;
    const bodyMessage = getBodyMessage(response?.body);
    const parts = [`GD Studio 请求失败（HTTP ${status}）`];
    if (bodyMessage) parts.push(bodyMessage);

    const retryAfter = getHeader(response?.headers, "retry-after");
    if (retryAfter && status === 429) parts.push(`请在 ${retryAfter} 秒后再试`);

    const error = pluginError(
      status > 0 ? `GD_HTTP_${status}` : "GD_HTTP_ERROR",
      parts.join("："),
    );
    // 结构化状态供限流/通道冷却判定，避免从文案反推。
    error.status = status;
    const retryAfterSeconds = Number(retryAfter);
    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
      error.retryAfterSeconds = retryAfterSeconds;
    }
    throw error;
  };

  const isHostRequestTimeoutError = (error) =>
    ["PLUGIN_REQUEST_TIMEOUT", "REQUEST_TIMEOUT", "ETIMEDOUT", "ESOCKETTIMEDOUT"].includes(
      String(error?.code),
    ) || error?.name === "TimeoutError";

  const isHostCancellationError = (error) =>
    ["PLUGIN_CANCELLED", "PLUGIN_ABORTED", "ABORT_ERR", "ERR_ABORTED"].includes(
      String(error?.code),
    ) || error?.name === "AbortError";

  const isOperationalError = (error) => error?.code === NETWORK_ERROR;

  const deadlineMessage = () => "SPlayer 播放地址解析已达到时间上限。";

  const deadlineError = () => pluginError(RESOLUTION_TIMEOUT_ERROR, deadlineMessage());

  const limitError = () =>
    pluginError(
      CROSS_PLATFORM_LIMIT_ERROR,
      "GD Studio 跨平台兜底已达到请求或时间上限。",
    );

  const requestWithTimeout = async (url, options, timeoutCode, message) => {
    const timeout = Number(options?.timeout) > 0 ? Number(options.timeout) : REQUEST_TIMEOUT;
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(() => splayer.request(url, options)),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(pluginError(timeoutCode, message)),
            timeout,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  const extractUrl = (body) => {
    const candidates = [
      body?.url,
      body?.data?.url,
      typeof body?.data === "string" ? body.data : undefined,
      typeof body?.result === "string" ? body.result : undefined,
    ];
    const url = candidates.find((value) => typeof value === "string" && value.trim());
    if (!url) return "";
    const trimmed = url.trim();
    return /^https?:\/\//i.test(trimmed) ? trimmed : "";
  };

  const extractCandidates = (body) => {
    if (Array.isArray(body)) return body;
    if (Array.isArray(body?.list)) return body.list;
    return null;
  };

  const normaliseExpiry = (value) => {
    const number = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(number) || number <= 0) return undefined;
    const expiry = number < 1_000_000_000_000 ? number * 1000 : number;
    return expiry > Date.now() ? expiry : undefined;
  };

  const extractExpiry = (body) => {
    for (const container of [body, body?.data, body?.result]) {
      if (!isRecord(container)) continue;
      for (const key of ["expire", "expiresAt", "expires_at", "urlExpire"]) {
        const expiry = normaliseExpiry(container[key]);
        if (expiry) return expiry;
      }
    }
    return undefined;
  };

  const performRequest = async (params, context) => {
    const { deadline, kind, budget } = context;
    const url = buildApiUrl(params);
    let timeout = REQUEST_TIMEOUT;

    if (budget) {
      const remaining = budget.deadline - Date.now();
      if (budget.remaining <= 0 || remaining <= 0) throw limitError();
      budget.remaining -= 1;
      timeout = Math.min(timeout, Math.max(1, remaining));
    }
    if (Number.isFinite(deadline)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw deadlineError();
      timeout = Math.min(timeout, Math.max(1, remaining));
    }

    const timeoutCode = RESOLUTION_TIMEOUT_ERROR;
    let response;
    try {
      response = await requestWithTimeout(
        url,
        { method: "GET", responseType: "json", timeout },
        timeoutCode,
        deadlineMessage(kind),
      );
    } catch (error) {
      if (isHostCancellationError(error)) throw error;
      if (
        [RESOLUTION_TIMEOUT_ERROR, CROSS_PLATFORM_LIMIT_ERROR].includes(String(error?.code))
      ) {
        throw error;
      }
      if (isHostRequestTimeoutError(error)) throw deadlineError();
      throw pluginError(
        NETWORK_ERROR,
        `GD Studio 网络请求失败：${error?.message ?? error}`,
      );
    }

    if (!response || Number(response.status) < 200 || Number(response.status) >= 300) {
      throwHttpError(response);
    }

    if (kind === "search") {
      if (!extractCandidates(response.body)) {
        throw pluginError(INVALID_RESPONSE, "GD Studio 搜索接口返回的结构无效。");
      }
      return response.body;
    }

    if (!isRecord(response.body)) {
      throw pluginError(INVALID_RESPONSE, "GD Studio 返回的不是有效 JSON 对象。");
    }
    return response.body;
  };

  const cacheTtlFor = (kind, body) => {
    if (kind === "search") {
      const list = extractCandidates(body);
      return list && list.length ? CACHE_TTL : UNAVAILABLE_TTL;
    }
    if (kind === "url") return extractUrl(body) ? URL_CACHE_TTL : UNAVAILABLE_TTL;
    return CACHE_TTL;
  };

  const requestJson = async (params, context = {}) => {
    const state = context.state ?? getSession();
    assertCurrentSession(state);

    // 缓存命中不消耗请求预算，但仍要遵守总时限。
    if (Number.isFinite(context.deadline) && Date.now() >= context.deadline) {
      throw deadlineError();
    }
    if (context.budget && Date.now() >= context.budget.deadline) throw limitError();

    const key = requestKey(params);
    if (state.config.smartCache) {
      const cached = readCache(state.responses, key);
      if (cached) {
        splayer.log.debug(`GD Studio 复用缓存：${params.types} ${params.source}`);
        return cached.body;
      }
    }

    // 缓存命中不算请求，因此限流闸门放在缓存之后、真正发请求之前。
    assertRateLimit(state);
    let body;
    try {
      body = await performRequest(params, { ...context, state });
    } catch (error) {
      noteRateLimit(state, error);
      throw error;
    }
    assertCurrentSession(state);

    if (state.config.smartCache) {
      writeCache(state.responses, key, { body }, Date.now() + cacheTtlFor(context.kind, body));
    }
    return body;
  };

  /**
   * 返回地址前的交付体检：只取前几个字节确认地址真的能拉流。
   * SPlayer 在播放失败时只会换音源、不会降音质，所以"这个地址能不能播"必须由插件自己兜。
   * @returns 不可用原因；可以放行时返回空串
   */
  const probeDelivery = async (url, state, deadline) => {
    const cached = readCache(state.probes, url);
    if (cached !== undefined) return cached;
    const remaining = Number.isFinite(deadline) ? deadline - Date.now() : Infinity;
    // 时间预算已经用尽时不再体检，交给调用方按原结果返回。
    if (remaining <= 0) return "";

    let response;
    try {
      response = await requestWithTimeout(
        url,
        {
          method: "GET",
          headers: { Range: PROBE_RANGE },
          responseType: "arraybuffer",
          timeout: Math.max(1, Math.min(PROBE_TIMEOUT, remaining)),
        },
        REQUEST_TIMEOUT_ERROR,
        `交付体检超过 ${Math.min(PROBE_TIMEOUT, remaining)} 毫秒。`,
      );
    } catch (error) {
      if (!UNREACHABLE_PROBE_CODES.has(String(error?.code))) {
        // 老版本宿主可能不支持自定义头或 arraybuffer；无法判定时按可用处理，绝不因此降级。
        splayer.log.debug(
          `GD Studio 交付体检无法判定，按可用处理：${error?.message ?? error}`,
        );
        return "";
      }
      const reason = `地址打不开（${error?.message ?? error}）`;
      writeCache(state.probes, url, reason, Date.now() + CACHE_TTL);
      return reason;
    }

    const status = Number(response?.status) || 0;
    if (status < 200 || status >= 300) {
      const reason = `地址返回 HTTP ${status}`;
      writeCache(state.probes, url, reason, Date.now() + CACHE_TTL);
      return reason;
    }

    writeCache(state.probes, url, "", Date.now() + CACHE_TTL);
    return "";
  };

  /**
   * GD Studio 会用响应体里的 br 说明实际交付的码率：实测请求 999 也可能返回 293kbps 的文件，
   * 因此不能拿请求档位当结果。FLAC 实测 842–1650kbps，16/44.1 无损通常不超过 1200。
   */
  const readServedQuality = (body) => {
    const bitrate = Number(body?.br);
    if (!Number.isFinite(bitrate) || bitrate <= 0) return "";
    if (bitrate <= 160) return "lq";
    if (bitrate <= 256) return "sq";
    if (bitrate <= 400) return "hq";
    if (bitrate < 1500) return "lossless";
    return "hi-res";
  };

  const normalisePlayback = (body, fallbackQuality) => {
    const url = extractUrl(body);
    if (!url) {
      const message = getBodyMessage(body);
      throw pluginError(
        NO_URL_ERROR,
        message ? `GD Studio 未返回播放地址：${message}` : "GD Studio 未返回播放地址。",
      );
    }

    const result = { url, quality: readServedQuality(body) || fallbackQuality };
    const expire = extractExpiry(body);
    if (expire) result.expire = expire;
    return result;
  };

  const selectBitrateLadder = (requestedQuality, config = {}) => {
    const logical = config.economyMode
      ? [requestedQuality, "lq"]
      : QUALITY_FALLBACKS[requestedQuality] ?? [requestedQuality];
    const bitrates = [];
    for (const quality of logical) {
      const bitrate = BITRATE_BY_QUALITY[quality];
      if (bitrate !== undefined && !bitrates.includes(bitrate)) bitrates.push(bitrate);
    }

    // 省请求模式本身就是用户显式选的取舍，不改它的顺序。
    if (!config.playableFirst || config.economyMode) return bitrates;
    return [
      ...bitrates.filter((bitrate) => !LOSSLESS_BITRATES.has(bitrate)),
      ...bitrates.filter((bitrate) => LOSSLESS_BITRATES.has(bitrate)),
    ];
  };

  const isTierUnavailable = (error) =>
    [NO_URL_ERROR, DELIVERY_UNUSABLE_ERROR].includes(String(error?.code));

  const isTerminalError = (error) =>
    isHostCancellationError(error) ||
    [
      RESOLUTION_TIMEOUT_ERROR,
      CROSS_PLATFORM_LIMIT_ERROR,
      RATE_LIMIT_ERROR,
      CHANNEL_COOLDOWN_ERROR,
      "GD_CONFIG_CHANGED",
    ].includes(String(error?.code)) ||
    /^GD_HTTP_(401|402|403|429)$/.test(String(error?.code));

  const resolveOnPlatform = async (source, quality, id, context = {}) => {
    const policy = getSourcePolicy(source);
    const state = context.state;
    const remembered = state ? readUnavailableTrack(state, source, id) : undefined;
    if (remembered) throw remembered;

    const requestedQuality = QUALITY_NAMES.includes(quality) ? quality : "hq";
    const ladder = selectBitrateLadder(requestedQuality, state?.config ?? {});
    let body;
    let lastError;
    let resolvedBitrate = ladder[0] ?? BITRATE_BY_QUALITY[requestedQuality];

    for (const [index, bitrate] of ladder.entries()) {
      try {
        body = await requestJson(
          { types: "url", source: policy.apiSource, id, br: bitrate },
          { ...context, kind: "url" },
        );
        const url = extractUrl(body);
        if (!url) {
          throw pluginError(
            NO_URL_ERROR,
            `${policy.name}没有 ${bitrate}k 档的播放地址。`,
          );
        }
        if (state?.config.verifyDelivery) {
          const unusable = await probeDelivery(url, state, context.deadline);
          if (unusable) throw pluginError(DELIVERY_UNUSABLE_ERROR, unusable);
        }
        resolvedBitrate = bitrate;
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        body = undefined;
        const hasFallback = index < ladder.length - 1;
        // 完整阶梯都没有地址说明是版权问题，而非某一档抖动；省请求模式的阶梯不完整，不能据此下结论。
        if (!hasFallback) {
          if (state && !state.config.economyMode && error?.code === NO_URL_ERROR) {
            rememberUnavailableTrack(state, source, id, error);
          }
          throw error;
        }
        if (!isTierUnavailable(error)) throw error;
      }
    }

    if (!body) throw lastError ?? pluginError(NO_URL_ERROR, "GD Studio 未返回播放地址。");
    return normalisePlayback(body, QUALITY_BY_BITRATE[resolvedBitrate] ?? requestedQuality);
  };

  const searchRaw = async (source, keyword, context = {}) => {
    const policy = getSourcePolicy(source);
    const body = await requestJson(
      {
        types: "search",
        source: policy.apiSource,
        name: keyword,
        count: context.count ?? SEARCH_RESULT_LIMIT,
        pages: context.page ?? 1,
      },
      { ...context, kind: "search" },
    );
    return normaliseCandidates(extractCandidates(body));
  };

  const findMatchingTracks = async (source, track, context = {}) => {
    const keyword = buildSearchKeyword(track);
    if (!keyword) return [];
    const candidates = await searchRaw(source, keyword, context);
    const economy = Boolean(context.state?.config.economyMode);
    return candidates
      .map((candidate) => ({
        candidate,
        id: candidate.id,
        score: matchScore(track, candidate),
      }))
      .filter((match) => match.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, economy ? 1 : CROSS_PLATFORM_MAX_CANDIDATES)
      .map(({ candidate, id }) => ({ candidate, id }));
  };

  const resolveAcrossPlatforms = async (policy, quality, track, deadline, state, primaryError) => {
    const budget = {
      remaining: state.config.economyMode ? 3 : CROSS_PLATFORM_REQUEST_BUDGET,
      deadline: Math.min(deadline, Date.now() + CROSS_PLATFORM_TIME_BUDGET),
    };
    const requestContext = { budget, deadline, state };
    const attempts = [];
    let completedSearch = false;
    let firstRecoverableError;

    for (const targetSource of policy.crossPlatform ?? []) {
      const targetPolicy = getSourcePolicy(targetSource);
      const cooldownSeconds = coolingDown(state.channelCooldowns, targetSource);
      if (cooldownSeconds > 0) {
        attempts.push({ name: targetPolicy.name, outcome: "cooldown", cooldownSeconds });
        splayer.log.warn(
          `${targetPolicy.name} 上游故障冷却中，${cooldownSeconds} 秒内跳过《${track.name}》的跨平台匹配。`,
        );
        continue;
      }

      try {
        const matches = await findMatchingTracks(targetSource, track, requestContext);
        // 搜索本身跑通了才算"这首歌在该平台不存在"；搜索失败只能说明平台不可用。
        completedSearch = true;
        attempts.push({
          name: targetPolicy.name,
          outcome: matches.length ? "candidates" : "no-match",
        });

        for (const { id } of matches) {
          try {
            const result = await resolveOnPlatform(targetSource, quality, id, requestContext);
            splayer.log.info(
              `《${track.name}》在${policy.name}不可用，已改用 ${targetPolicy.name} 播放（${id}），交付音质 ${result.quality}。`,
            );
            return result;
          } catch (error) {
            if (isTerminalError(error)) throw error;
            firstRecoverableError ??= error;
            noteChannelFailure(state, targetSource, error);
            if (coolingDown(state.channelCooldowns, targetSource) > 0) break;
            splayer.log.warn(
              `${targetPolicy.name} 匹配《${track.name}》失败：${error?.message ?? error}`,
            );
          }
        }
      } catch (error) {
        if (isTerminalError(error)) throw error;
        firstRecoverableError ??= error;
        attempts.push({ name: targetPolicy.name, outcome: "error", error });
        splayer.log.warn(
          `${targetPolicy.name} 匹配《${track.name}》失败：${error?.message ?? error}`,
        );
      }
    }

    // 没有平台完成搜索时保留各通道故障，不能报成"没有这首歌"。
    if (!completedSearch && attempts.length > 0 && !isOperationalError(firstRecoverableError)) {
      const detail = attempts
        .map(({ name, outcome, error, cooldownSeconds }) =>
          outcome === "cooldown"
            ? `${name}（${cooldownSeconds} 秒冷却中，未发起请求）`
            : `${name}（${error?.message ?? "未完成搜索"}）`,
        )
        .join("；");
      throw pluginError(
        CROSS_PLATFORM_UNAVAILABLE_ERROR,
        `${policy.name}无法提供《${track.name}》的播放地址（${primaryError?.message ?? "没有可用音质"}），且跨平台搜索未能完成：${detail}。以上是各搜索或解析通道的状态，不代表歌曲不存在，请稍后重试或更换音源。`,
      );
    }

    if (firstRecoverableError) throw firstRecoverableError;

    if (budget.remaining <= 0 || budget.deadline - Date.now() <= 0) throw limitError();
    return null;
  };

  const resolveUncached = async ({ source, quality, id, track }, state) => {
    const policy = getSourcePolicy(source);
    const descriptor = getTrackDescriptor(track);
    const requestedQuality = QUALITY_NAMES.includes(quality) ? quality : "hq";
    const deadline = Date.now() + RESOLUTION_TIME_BUDGET;
    const canCrossSearch =
      Boolean(policy.crossPlatform?.length) &&
      Boolean(descriptor.name) &&
      state.config.crossPlatformFallback;

    const cooldownSeconds = coolingDown(state.channelCooldowns, source);
    if (cooldownSeconds > 0) {
      const cooldownError = pluginError(
        CHANNEL_COOLDOWN_ERROR,
        `${policy.name}上游通道冷却中（还剩 ${cooldownSeconds} 秒），跳过本次主渠道请求。`,
      );
      if (!canCrossSearch) throw cooldownError;

      const fallback = await resolveAcrossPlatforms(
        policy,
        requestedQuality,
        descriptor,
        deadline,
        state,
        cooldownError,
      );
      if (fallback) return fallback;
      throw pluginError(
        CROSS_PLATFORM_UNAVAILABLE_ERROR,
        `${cooldownError.message}且在其他平台中未匹配到《${descriptor.name}》。请稍后重试或更换音源。`,
      );
    }

    try {
      const result = await resolveOnPlatform(source, requestedQuality, id, { deadline, state });
      // 成功也留一行：宿主只在插件抛错时写日志，没有这行就分不清"插件没被调用"和"插件已成功返回"。
      splayer.log.info(
        `《${descriptor.name || id}》已由${policy.name}解析，交付音质 ${result.quality}。`,
      );
      return result;
    } catch (error) {
      noteChannelFailure(state, source, error);
      const shouldCrossSearch =
        canCrossSearch && (error?.code === NO_URL_ERROR || isUpstreamUnavailableError(error));
      if (!shouldCrossSearch) throw error;

      const fallback = await resolveAcrossPlatforms(
        policy,
        requestedQuality,
        descriptor,
        deadline,
        state,
        error,
      );
      if (fallback) return fallback;

      const platformNames = (policy.crossPlatform ?? [])
        .map((target) => getSourcePolicy(target).name)
        .join("、");
      if (isUpstreamUnavailableError(error)) {
        throw pluginError(
          CROSS_PLATFORM_UNAVAILABLE_ERROR,
          `${policy.name}无法提供《${descriptor.name}》的播放地址（${error.message}），且在 ${platformNames} 中未匹配到同一首歌。以上是各搜索或解析通道的状态，不代表歌曲不存在，请稍后重试或更换音源。`,
        );
      }
      throw pluginError(
        TRACK_UNAVAILABLE_ERROR,
        `${policy.name}无法提供《${descriptor.name}》的播放地址（${error.message}），且在 ${platformNames} 中未匹配到同一首歌。`,
      );
    }
  };

  const resolve = async (input) => {
    const state = getSession();
    const hostQuality = QUALITY_NAMES.includes(input.quality) ? input.quality : "hq";
    // 默认按插件设置请求；只有设置为 auto 时才跟随播放器的音质档位。
    const targetQuality = state.config.quality === "auto" ? hostQuality : state.config.quality;
    const key = JSON.stringify([
      input.source,
      String(input.id),
      targetQuality,
      getTrackDescriptor(input.track),
    ]);
    const result = await sharePending(state, state.pending, key, () =>
      resolveUncached({ ...input, quality: targetQuality }, state),
    );
    assertCurrentSession(state);
    return { ...result };
  };

  return { resolve };
};

const resolutionImplementation = createResolutionCore();
const { resolve: resolveTrack } = resolutionImplementation;

const resolveUrl = async ({ source, quality, musicInfo }) => {
  const id = getMusicId(source, musicInfo);
  return resolveTrack({ source, quality, id, track: musicInfo });
};

const createRuntimeAdapter = (runtime) => ({
  register(metadata) {
    runtime.register(metadata);
  },
  bind({ musicUrl }) {
    runtime.on("musicUrl", musicUrl);
  },
});

const runtimeAdapter = createRuntimeAdapter(splayer);
runtimeAdapter.register({
  sources: {
    // 只注册内置网易云：曲目仍由 SPlayer 官方搜索产生，插件只补播放地址。
    wy: {
      name: SOURCE_POLICIES.wy.name,
      actions: ["musicUrl"],
      qualities: QUALITY_NAMES,
    },
  },
  settings: [
    {
      key: QUALITY_SETTING,
      type: "select",
      label: "插件音质（默认 hi-res）",
      description:
        "插件按这个档位请求播放地址，并从该档逐级降档；播放器自带的音质设置不会限制插件，只有选择 auto 才跟随它。GD Studio 的无损文件较大（实测单曲 27–52MB），介意流量或设备解码能力时可选 hq。",
      default: DEFAULT_PLUGIN_QUALITY,
      options: [
        { label: "Hi-Res（24bit 无损，最大）", value: "hi-res" },
        { label: "无损 Lossless", value: "lossless" },
        { label: "HQ 320k", value: "hq" },
        { label: "SQ 192k", value: "sq" },
        { label: "LQ 128k", value: "lq" },
        { label: "跟随播放器音质（auto）", value: "auto" },
      ],
    },
    {
      key: "crossPlatformFallback",
      type: "switch",
      label: "主渠道不可用时跨平台兜底",
      description:
        "当前来源没有版权或上游故障时，按歌名、歌手在其他平台匹配同一首歌，再用目标平台自己的 ID 解析。每次匹配会额外消耗 GD Studio 请求额度。",
      default: true,
    },
    {
      key: "smartCache",
      type: "switch",
      label: "智能请求复用",
      description:
        "合并相同播放请求；缓存跨平台搜索结果与短期有效的播放地址，短暂跳过明确不可用的音质。仅保存在内存，切换配置会清空。",
      default: true,
    },
    {
      key: "verifyDelivery",
      type: "switch",
      label: "交付体检（返回前验证地址能拉流）",
      description:
        "拿到播放地址后先取前几个字节确认可访问，地址被拒或打不开时自动改用下一档。这是 CDN 请求，不消耗 GD Studio 额度。",
      default: true,
    },
    {
      key: "playableFirst",
      type: "switch",
      label: "可播放优先（无损档留到最后）",
      description:
        "默认优先无损（网易云实测单曲 27–52MB）。网络或设备吃不下大文件时打开：先取 320k / 192k / 128k，仍不可用再回头尝试无损。",
      default: false,
    },
    {
      key: "economyMode",
      type: "switch",
      label: "省请求模式",
      description:
        "只尝试目标音质与 128k；跨平台每个平台最多一个候选、最多三次请求。可能错过中间音质或可播版本。",
      default: false,
    },
  ],
});
runtimeAdapter.bind({ musicUrl: resolveUrl });
