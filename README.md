# GD Studio 音源 · SPlayer-Next 音源插件

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Plugin](https://img.shields.io/badge/SPlayer--Next-source%20plugin-07c160.svg)](https://github.com/SPlayer-Dev/SPlayer-Next)

> **官方接口拿不到网易云的播放地址时，用 [GD 音乐台](https://music.gdstudio.xyz/) 接管；默认请求 hi-res，歌词和封面继续用官方。**

一个可导入 [SPlayer-Next](https://github.com/SPlayer-Dev/SPlayer-Next) 的原生 `source` 音源插件，只注册内置来源 `wy` 的 `musicUrl`。当 SPlayer 官方网易云接口返回不可用、仅试听或没有版权时，插件按官方曲目 ID 调用 [GD Studio 在线音乐 API](https://music-api.gdstudio.xyz/api.php) 解析播放地址，逐档匹配音质并做交付体检。**不提供搜索曲库，也不接管歌词和封面。不需要 API Key。**

---

## v1.2.0 更新

- 移除「GD Studio 网易云曲库」「GD Studio JOOX 曲库」两个搜索入口，搜索页只保留 SPlayer 自带来源。
- 移除 GD 歌词、封面与元数据搜索：歌词和封面完全使用官方数据。
- 只注册 `wy` 的 `musicUrl`。插件被调用时直接用官方曲目的 ID 向 GD Studio 要地址，不再搜索、不产生额外曲目。
- 插件音质选择保留，默认 `hi-res`；跨平台兜底、交付体检、缓存与限流保持不变。

## 它能做什么、不能做什么

| 场景 | 结果 |
| --- | --- |
| 官方接口返回完整地址 | 直接播放官方地址，**插件不会被调用**（宿主固定顺序） |
| 官方接口返回不可用 / 仅试听 / 无版权 | 插件接管，返回 GD Studio 的地址（默认 hi-res） |
| 歌词、封面 | 始终使用官方 |
| 搜索、收藏、歌单 | 使用 SPlayer 官方曲目；插件不再提供独立曲库 |

> **想让官方歌曲也走 GD Studio？** 请把 SPlayer 的音质设置为 **Hi-Res**（设置 → 播放 → 音质）。官方接口在拿不到该档位时会返回不可用，宿主随后调用本插件，插件再按 GD Studio 的 hi-res 档解析。插件自身的音质默认也是 `hi-res`，不会降级。

SPlayer-Next 的插件 API 没有“插件优先于官方接口”的开关，也没有“只替换地址、保留曲目身份”的接口；官方成功时插件无法插入。这是宿主行为，不是插件可以绕过的限制。

## 30 秒上手

1. 下载 [`dist/gdstudio.splayer-source.js`](./dist/gdstudio.splayer-source.js)
2. 打开 SPlayer-Next → **设置 → 插件管理 → 本地导入**，选择该文件
3. 打开 **设置 → 播放 → 音质**，选择 **Hi-Res**（关键一步，见上一节）
4. 正常播放官方搜索或收藏里的网易云歌曲；官方拿不到 hi-res 时插件会自动接管
5. 想限制插件拉取的音质：插件设置 → 插件音质 → 选 `hq` / `lossless` 等

判断是否接管成功：日志里会出现 `《歌名》已由GD Studio 网易云解析，交付音质 hi-res。`；如果没有任何 `[plugin:gdstudio.splayer-source]` 行，说明官方已经给出了可用地址。

## 支持范围

| SPlayer 来源 | source key | GD Studio `source` | 能力 |
| --- | --- | --- | --- |
| 网易云音乐 | `wy`（内置来源） | `netease` | 官方失败时补播放地址；歌词、封面仍用官方 |

GD Studio 文档还列出 `joox`、`tencent`、`kuwo`、`tidal`、`qobuz`、`apple`、`ytmusic`、`spotify`、`bilibili`。实测（2026-10-29）：`tencent` / `kuwo` / `tidal` / `qobuz` / `apple` / `ytmusic` 返回 HTTP 400，`spotify` 返回 503 维护页，`bilibili` 搜索为空。`joox` 只作为插件内部的跨平台兜底目标使用，不在搜索页注册。

## 音质

插件设置里的**插件音质**决定起始档位（默认 `hi-res`），播放器传入的音质不会限制插件；只有把插件音质设为 `auto` 时才跟随播放器。

| SPlayer 音质 | 请求 `br` | 说明 |
| --- | --- | --- |
| `hi-res` | `999` | 24bit 无损档 |
| `lossless` | `740` | 16bit 无损档 |
| `hq` | `320` | 320k 有损 |
| `sq` | `192` | 192k 有损 |
| `lq` | `128` | 128k 有损 |

请求失败（返回空 `url` / `br <= 0`）或交付体检不通过时，按 `hi-res → lossless → hq → sq → lq` 降档；`hq` 与 `sq` 使用不同的 `br`，不会重复请求。

**上报音质取服务端实际交付的码率**，不照抄请求档位：

| 响应 `br` | 上报音质 |
| --- | --- |
| ≤ 160 | `lq` |
| ≤ 256 | `sq` |
| ≤ 400 | `hq` |
| < 1500 | `lossless` |
| ≥ 1500 | `hi-res` |

原因有两个，都是实测结论（见 [验证记录](./docs/validation.md)）：

- 请求 `999` 时服务端可能返回 293kbps 的文件（曲目只有低码率版本），此时上报 `hq`；
- GD Studio 对网易云的 `740` 与 `999` 返回**同一个文件**，`br` 是文件的真实码率（实测 820 / 842 / 980 / 1124 / 1650 kbps）。接口不区分 16/24-bit，`br ≥ 1500` 是插件能给出的最接近判断。

### 可播放优先（可选）

网易云无损单曲实测 27–52MB，网络或设备吃不下时打开 **`playableFirst`**（默认关闭）：

```text
320k → 192k → 128k → 无损（740 / 999）
```

无损档仍会作为最后兜底，只是排到阶梯末尾。

## 交付体检

"服务端返回了地址"不等于"这个地址能播"。SPlayer-Next 在播放失败时只会换音源、不会降音质，所以插件自己补上这一层：

```text
请求 hi-res
  └─ 999 档 → 拿到地址 → 体检（Range: bytes=0-3，CDN 请求，不消耗接口额度）
       ├─ 2xx（实测网易云 CDN 返回 206）→ 返回，音质最好
       └─ 被拒 / 打不开 / 超时 → 降一档重试
```

体检结果按地址缓存 5 分钟；关闭 `verifyDelivery` 后直接返回解析结果。老版本宿主若不支持自定义请求头或二进制响应，体检按"无法判定"处理，**不会因此降级**。

## 跨平台兜底

当网易云整条音质阶梯都没有地址，或返回 `502/503/504` 上游故障，且 `crossPlatformFallback` 开启时：

1. 用去掉版本标记的歌名 + 第一位歌手搜索 JOOX；
2. 按歌名、歌手校验候选，避免把 Live、Remix、翻唱当成原曲；
3. 用 JOOX 自己的 ID 调用 `types=url`，不跨平台复用 ID；
4. 全程受 18 秒解析时间、最多 4 次请求、每个平台最多 2 个候选的限制。

候选歌名必须在规范化后相同（忽略大小写、空白和标点）。这里有一个**单向**的宽松匹配：如果原曲自己的标题带版本标记（如 `Love (Live)`），而候选是干净标题（`Love`），则视为同一首歌；反向不成立——原曲标题干净时，带 `(Live)`、`(Remix)` 等标记的候选仍会被拒绝。

> 2026-10-29 实测 JOOX 播放通道返回空地址，跨平台兜底目前多半会失败，失败时保留原始错误。

## 省请求配置

| 配置 | 默认 | 行为与取舍 |
| --- | --- | --- |
| 插件音质（`quality`） | `hi-res` | 插件按此档位请求并从该档降级；`auto` 表示跟随播放器音质。选 `hq` 时最多只拉 320k |
| 跨平台兜底（`crossPlatformFallback`） | 开启 | 网易云无版权或上游故障时去 JOOX 找同一首 |
| 智能请求复用（`smartCache`） | 开启 | 合并相同并发播放请求，复用搜索结果与 90 秒内的播放地址 |
| 交付体检（`verifyDelivery`） | 开启 | 返回地址前取前几个字节确认能拉流，打不开就降一档 |
| 可播放优先（`playableFirst`） | 关闭 | 默认无损优先；打开后先取 320k / 192k / 128k |
| 省请求模式（`economyMode`） | 关闭 | 只试目标音质与 128k；跨平台最多 3 次请求 |

**缓存与冷却的边界**

- 播放地址没有明确的过期时间，只缓存 90 秒，避免把过期链接留给下一次播放；搜索结果缓存 5 分钟，空搜索结果缓存 60 秒。
- 明确"整条音质阶梯都没有地址"的歌曲按 5 分钟记住，期间直接进入跨平台匹配（省请求模式不记）。
- 命中 `429` 按 `Retry-After` 进入冷却（没有该响应头时按 60 秒，最长 15 分钟）；冷却期内直接返回 `GD_RATE_LIMITED` 且**不发出任何请求**。
- `502/503/504` 冷却对应平台 2 分钟（优先 `Retry-After`，最长 15 分钟）；冷却期内主渠道直接跳过，必要时走兜底。
- 每张缓存表最多 128 项，只存于插件内存；重载插件或修改任意设置后失效。

## 解析流程

```text
SPlayer 官方接口解析网易云曲目
        ├─ 成功 → 直接播放官方地址（插件不参与，歌词/封面/收藏均为官方）
        └─ 不可用 / 仅试听 / 无版权
                ↓
        插件按 musicInfo 的 songId 调用
        types=url&source=netease&id=...&br=999|740|320|192|128
                ↓
        交付体检（Range 探测） → 返回 { url, quality }
                ↓
        曲目仍是官方网易云曲目，歌词与封面继续由官方提供
```

### 为什么有时看不到插件生效

插件只负责补地址，不改变曲目来源。以下情况都不会调用插件：

- 官方接口已经返回完整、非试听的地址；
- 曲目来自本地、流媒体或其它平台；
- 插件被禁用或未就绪。

判断方法：日志里搜索 `[plugin:gdstudio.splayer-source]`。没有这行就说明宿主没有调用插件。

## 错误处理

插件把 GD Studio 的 HTTP 状态和响应体 `detail` 转换成 SPlayer 插件错误：

| 错误码 | 含义 |
| --- | --- |
| `GD_HTTP_400` | 参数不合法，常见于来源未开放（`Value of source is not supported`） |
| `GD_HTTP_429` | 超过频率限制；带 `Retry-After` 时按它冷却 |
| `GD_HTTP_5xx` | 上游平台故障；对应平台进入 2 分钟冷却 |
| `GD_RATE_LIMITED` | 处于限流冷却期，未发出请求，附带剩余秒数 |
| `GD_CHANNEL_COOLDOWN` | 平台处于上游故障冷却期，未发出该平台请求 |
| `GD_DELIVERY_UNUSABLE` | 整条阶梯的地址都通不过交付体检 |
| `GD_NO_URL` | 该音质档位没有播放地址（整条阶梯都为空时抛出） |
| `GD_TRACK_UNAVAILABLE` | 至少一个平台真正搜索过，但没有匹配到同一首歌 |
| `GD_CROSS_PLATFORM_UNAVAILABLE` | 跨平台兜底未能完成搜索，附各通道状态 |
| `GD_CROSS_PLATFORM_LIMIT` | 跨平台兜底达到请求或时间上限 |
| `GD_NETWORK_ERROR` / `GD_REQUEST_TIMEOUT` / `GD_RESOLUTION_TIMEOUT` | 网络异常 / 请求超时 / 整体解析超时 |
| `GD_INVALID_RESPONSE` | 接口返回的不是预期 JSON 结构 |
| `GD_TRACK_INVALID` / `GD_SOURCE_UNSUPPORTED` | 缺少平台 ID / 不支持的音源 |
| `GD_CONFIG_CHANGED` | 解析途中配置变化，需要重新播放 |

## 当前限制

- SPlayer-Next 没有“插件优先于官方接口”的设置；官方成功时插件无法接管，也没有只替换地址的接口。想要 GD 的地址，只能让官方在目标音质上失败（把播放器音质设为 Hi-Res），或使用带独立曲库的旧版本。
- `hi-res` 请求会先试 999 档，网易云无损单曲实测 27–52MB；流量或设备吃不消时把插件音质改成 `hq` 或 `auto`。
- JOOX 在 2026-10-29 的实测中播放地址始终为空（搜索/歌词/封面正常），因此跨平台兜底只在接口恢复后才有意义。
- GD Studio 搜索接口不返回时长，跨平台匹配只能依据歌名与歌手，仍可能匹配到翻唱或不同混音。
- 接口限流为 5 分钟内不超过 50 次请求，连续试听多首无版权歌可能触发 `GD_RATE_LIMITED`，等一分钟再试。
- 仅使用你有权访问和播放的音乐，并遵守 GD Studio、音乐平台及当地法律法规。

## 开发与测试

需要 Node.js 20 或更高版本。入口是 `src/plugin.js` —— 一个不依赖 npm 包的单文件脚本，便于直接导入 SPlayer-Next。

```bash
node --test          # Node 内置 test runner + 模拟 splayer 宿主
node scripts/build.mjs        # 把入口复制为导入产物 dist/gdstudio.splayer-source.js
node --check src/plugin.js    # 语法检查
node scripts/check-dist.mjs   # 源码与产物字节一致
node scripts/check-artifact.mjs  # 产物可加载且能解析
```

| 测试文件 | 覆盖 |
| --- | --- |
| `test/plugin.test.js` | 注册声明、音质选择与默认 hi-res、音质上报、交付体检、缓存、错误处理 |
| `test/fallback.test.js` | 跨平台匹配、版本标记规则、503 冷却、429 限流 |
| `test/quota.test.js` | 省请求模式、可播放优先、不可用记忆、缓存过期、超时与网络错误映射 |
| `test/release-seam.test.js` | 源码/产物字节一致、CI 步骤、产物冒烟 |

测试宿主 `test/plugin-host.js` 只注入文档列出的 `splayer`、`URL`、`Promise`、`setTimeout`、`Date` 等全局对象，并按宿主的方式序列化处理器结果。

## 发布到 SPlayer 插件市场

官方市场投稿入口是 [SPlayer-Dev/plugins 新建插件 Issue](https://github.com/SPlayer-Dev/plugins/issues/new?template=new-plugin.yml)。投稿时选择 `source`，填写 `gdstudio.splayer-source`，上传 `dist/gdstudio.splayer-source.js`，并确认自己对脚本内容和合法性负责。

## 许可与免责声明

本项目代码采用 [MIT 许可证](./LICENSE)。本项目是社区插件，与 SPlayer-Next、GD Studio、网易云音乐、JOOX 均无官方隶属或背书关系。GD Studio API 的使用需遵守其声明的 [CC BY-NC 4.0](https://music-api.gdstudio.xyz/api.php) 许可与平台条款，请注明出处「GD音乐台(music.gdstudio.xyz)」，不要用于商业用途。

<sub>关键词：SPlayer-Next 插件 · 音源插件 · source plugin · 网易云音乐 · JOOX · 无损音乐 · FLAC · 播放地址解析 · 跨平台匹配 · GD Studio API · GD 音乐台 · music source plugin · NetEase Cloud Music</sub>
