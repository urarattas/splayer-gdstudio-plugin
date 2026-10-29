# GD Studio 音源 · SPlayer-Next 音源插件

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Plugin](https://img.shields.io/badge/SPlayer--Next-source%20plugin-07c160.svg)](https://github.com/SPlayer-Dev/SPlayer-Next)

> **让 SPlayer-Next 用 [GD 音乐台](https://music.gdstudio.xyz/) 的公开 API 播放网易云与 JOOX 的歌曲：母带、无损、320k 逐档尝试，地址打不开自动降档，主渠道没有版权时去另一个平台找同一首。**

一个可导入 [SPlayer-Next](https://github.com/SPlayer-Dev/SPlayer-Next) 的原生 `source` 音源插件，基于 [GD Studio 在线音乐 API](https://music-api.gdstudio.xyz/api.php) 解析网易云（`wy`）与 JOOX 的播放地址、歌词和封面，并提供「GD Studio 网易云曲库」「GD Studio JOOX 曲库」两个独立曲库，用来直接替代 SPlayer 内置音源。**不需要 API Key。**

## v1.1.0 更新

- 新增「**GD Studio 网易云曲库**」独立来源：搜索页切到「插件」并选择它之后，搜索与播放**完全由插件提供**，不再经过 SPlayer 官方接口 —— 这才是真正意义上的「替换 SPlayer 音源」。
- 新增**插件音质选择**，默认 `hi-res`。以前插件会跟着播放器的音质档位走（SPlayer 默认 `hq`），所以最多只能拉到 HQ；现在插件按自己的档位请求，只有选 `auto` 才跟随播放器。
- `hi-res` 请求会先试 999（24bit 无损）再逐级降档；GD Studio 对网易云的 740/999 返回同一个文件，实际音质仍按响应 `br` 上报。

---

## 它解决什么问题

| 你遇到的 | 插件怎么做 |
| --- | --- |
| 会员歌曲、无损歌曲放不出来 | 按插件音质（默认 hi-res）逐档调用 `types=url`，`hi-res → lossless → hq → sq → lq`，命中即返回 |
| 服务端给了地址，播放器却打不开 | **交付体检**：返回前先用 `Range: bytes=0-3` 确认地址真能拉流，打不开就自动降一档 |
| 请求了 999 却拿到低码率文件 | 按响应体里的实际 `br` 上报音质，不照抄请求档位 |
| 网易云没有版权的歌 | 按歌名、歌手去 JOOX 搜同一首，改用那边的 ID 解析；JOOX 不可用时反向兜底 |
| 连续解析把请求额度打光 | 结果缓存 + 429 限流冷却 + 上游 5xx 通道熔断 |
| 歌词、封面缺失 | 通过 `types=lyric` / `types=pic` 兜底，并复用搜索候选里的 `lyric_id`、`pic_id` |
| 想直接搜 JOOX 的歌 | 注册独立来源 `joox`，出现在搜索页的「插件」入口 |

## 30 秒上手

1. 下载 [`dist/gdstudio.splayer-source.js`](./dist/gdstudio.splayer-source.js)
2. 打开 SPlayer-Next → **设置 → 插件管理 → 本地导入**，选择该文件
3. 回搜索页正常播放网易云歌曲即可（官方接口拿不到地址时插件兜底）
4. 想完全替换 SPlayer 音源：搜索页切到「插件」→ 来源选「GD Studio 网易云曲库」或「GD Studio JOOX 曲库」，搜索与播放都只经过 GD Studio
5. 想让插件少拉大文件：插件设置 → 插件音质 → 选 `hq` / `auto`

> 插件不会改变 SPlayer-Next 的解析顺序：官方接口先解析，官方拿不到完整地址时才轮到本插件。详见 [何时会走插件](#何时会走插件)。

## 支持范围

| SPlayer 来源 | source key | GD Studio `source` | 能力 |
| --- | --- | --- | --- |
| 网易云音乐 | `wy`（内置来源） | `netease` | 官方接口失败时的播放地址、歌词、封面、元数据搜索 |
| GD Studio 网易云曲库 | `gdstudio`（独立来源） | `netease` | 在「插件」中搜索网易云曲库并播放，**不经过官方接口** |
| GD Studio JOOX 曲库 | `joox`（独立来源） | `joox` | 在「插件」中搜索 JOOX 曲库并播放 |

前两个来源共用 GD Studio 的网易云接口，区别只在入口：`wy` 是官方解析的后备，`gdstudio` 则是直接替代官方搜索的独立曲库。

GD Studio 文档还列出 `tencent`、`kuwo`、`tidal`、`qobuz`、`apple`、`ytmusic`、`spotify`、`bilibili`。实测（2026-10-29）：`tencent` / `kuwo` / `tidal` / `qobuz` / `apple` / `ytmusic` 的搜索接口返回 HTTP 400 `Value of source is not supported.`，`spotify` 返回 503 维护页，`bilibili` 搜索返回空数组，因此本插件没有注册它们。接口恢复后可在 `SOURCE_POLICIES` 里加一条策略即可接入。

## 音质

插件设置里的**插件音质**决定起始档位（默认 `hi-res`），播放器自带的音质设置不会限制插件；只有把它设为 `auto` 时才跟随播放器的音质档位。所以默认情况下即使播放器选的是 HQ，插件也会先尝试无损档，再逐级降档。

SPlayer 的逻辑音质映射到 GD Studio 的 `br` 参数：

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

SPlayer 的搜索结果会携带来源标识，插件不会根据歌名猜平台：

| SPlayer 来源 | 主渠道 | 兜底目标 |
| --- | --- | --- |
| `wy` | 网易云（netease） | JOOX |
| `joox` | JOOX | 网易云（netease） |

当主渠道整条音质阶梯都没有地址，或返回 `502/503/504` 上游故障，且 `crossPlatformFallback` 开启时：

1. 用去掉版本标记的歌名 + 第一位歌手搜索目标平台；
2. 按歌名、歌手校验候选，避免把 Live、Remix、翻唱当成原曲；
3. 用目标平台自己的 ID 调用 `types=url`，不跨平台复用 ID；
4. 全程受 18 秒解析时间、最多 4 次请求、每个平台最多 2 个候选的限制。

候选歌名必须在规范化后相同（忽略大小写、空白和标点）。这里有一个**单向**的宽松匹配：如果原曲自己的标题带版本标记（如 `Love (Live)`），而候选是干净标题（`Love`），则视为同一首歌；反向不成立——原曲标题干净时，带 `(Live)`、`(Remix)` 等标记的候选仍会被拒绝。

GD Studio 的搜索项**没有时长字段**，因此跨平台匹配只能依据歌名与歌手；宿主传入的 `interval` 只在候选恰好带时长时参与校验。

## 省请求配置

| 配置 | 默认 | 行为与取舍 |
| --- | --- | --- |
| 插件音质（`quality`） | `hi-res` | 插件按此档位请求并从该档降级；`auto` 表示跟随播放器音质。选 `hq` 时最多只拉 320k |
| 跨平台兜底（`crossPlatformFallback`） | 开启 | 主渠道无版权或上游故障时去另一个平台找同一首 |
| 智能请求复用（`smartCache`） | 开启 | 合并相同并发播放请求，复用搜索结果、歌词、封面与 90 秒内的播放地址 |
| 交付体检（`verifyDelivery`） | 开启 | 返回地址前取前几个字节确认能拉流，打不开就降一档 |
| 可播放优先（`playableFirst`） | 关闭 | 默认无损优先；打开后先取 320k / 192k / 128k |
| 省请求模式（`economyMode`） | 关闭 | 只试目标音质与 128k；跨平台每个平台 1 个候选、最多 3 次请求 |
| 元数据额外请求（`metadataFallback`） | 开启 | 关闭后不再为歌词、封面和元数据匹配调用接口；独立 JOOX 搜索不受影响 |

**缓存与冷却的边界**

- 播放地址没有明确的过期时间，只缓存 90 秒，避免把过期链接留给下一次播放；搜索结果缓存 5 分钟，空搜索结果缓存 60 秒，歌词与封面缓存 5 分钟。
- 明确"整条音质阶梯都没有地址"的歌曲按 5 分钟记住，期间直接进入跨平台匹配（省请求模式不记）。
- 命中 `429` 按 `Retry-After` 进入冷却（没有该响应头时按 60 秒，最长 15 分钟）；冷却期内直接返回 `GD_RATE_LIMITED` 且**不发出任何请求**。
- `502/503/504` 冷却对应平台 2 分钟（优先 `Retry-After`，最长 15 分钟）；冷却期内主渠道直接跳过，必要时走兜底。
- 每张缓存表最多 128 项，只存于插件内存；重载插件或修改任意设置后失效。

## 解析流程

```text
SPlayer 内置搜索结果（wy / joox）
        ↓
读取 musicInfo 的平台 ID
        ↓
types=url&source=netease|joox&id=...&br=999|740|320|192|128
        ↓
交付体检（Range 探测）
        ↓
返回 { url, quality }
```

### 何时会走插件

SPlayer-Next 的解析顺序由宿主决定，插件无法改变：官方接口先解析；取得完整、非试听的地址就直接播放，只有官方接口返回不可用、仅 VIP 或仅试听时才调用音源插件。因此"非会员但有版权"并不是是否调用插件的判断条件：关键是官方接口是否返回了可用的完整地址。如果官方已返回低音质完整地址，插件不会被调用，也就无法升级音质。

**想绕过这个顺序，就用独立曲库。** 搜索页切到「插件」后选择「GD Studio 网易云曲库」或「GD Studio JOOX 曲库」，搜到的曲目 `source` 是 `plugin`，播放器会直接向插件要地址，官方接口完全不参与——这就是本插件能提供的「替换 SPlayer 音源」。

看日志可以确认：解析成功会有一行 `《歌名》已由 GD Studio 网易云解析，交付音质 …`；失败会有 `resolveUrl rejected`。两者都没有，说明官方接口已经给出可用地址、宿主根本没调用插件。

日志位于 `app-data/logs/<日期>.log`，带 `[plugin:gdstudio.splayer-source]` 前缀。

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
| `GD_CROSS_PLATFORM_UNAVAILABLE` | 所有目标平台均未能完成搜索，附各通道状态 |
| `GD_CROSS_PLATFORM_LIMIT` | 跨平台兜底达到请求或时间上限 |
| `GD_NETWORK_ERROR` / `GD_REQUEST_TIMEOUT` / `GD_RESOLUTION_TIMEOUT` / `GD_METADATA_TIMEOUT` | 网络异常 / 请求超时 / 整体解析超时 / 元数据动作超时 |
| `GD_INVALID_RESPONSE` | 接口返回的不是预期 JSON 结构 |
| `GD_TRACK_INVALID` / `GD_SOURCE_UNSUPPORTED` | 缺少平台 ID / 不支持的音源 |
| `GD_CONFIG_CHANGED` | 解析途中配置变化，需要重新播放 |

## 当前限制

- GD Studio 目前只开放 `netease` 与 `joox`。QQ 音乐、酷狗、TIDAL、Qobuz、Apple Music、YouTube Music、Spotify 的接口返回 400，B 站搜索返回空数组，所以这些平台不可用。
- JOOX 的搜索、歌词、封面可用，但播放地址在 2026-10-29 的实测中始终返回 `{"url":"","br":-1}`（含周杰伦《晴天》等主流曲目）。此时 JOOX 曲目会尝试兜底到网易云，找不到就报 `GD_NO_URL` / `GD_TRACK_UNAVAILABLE`。
- GD Studio 搜索接口不返回时长，跨平台匹配只能依据歌名与歌手，仍可能匹配到翻唱或不同混音；匹配错误时可关闭兜底开关。
- 接口限流为 5 分钟内不超过 50 次请求，连续试听多首无版权歌可能触发 `GD_RATE_LIMITED`，等一分钟再试。
- 返回的播放地址来自网易云 CDN，可能有时间限制；没有过期字段时插件只缓存 90 秒。
- 插件音质默认 `hi-res`，网易云无损单曲实测 27–52MB；流量或设备吃不消时把插件音质改成 `hq` 或 `auto`。
- 独立曲库的曲目由 `gdstudio` / `joox` 两个 source key 标识，与内置来源的 `wy` 互不影响；移除插件后队列中的插件歌曲会保留但无法播放。
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
| `test/plugin.test.js` | 注册声明、音质选择与默认 hi-res、音质上报、交付体检、缓存、歌词、封面、错误处理 |
| `test/search.test.js` | GD Studio 网易云 / JOOX 曲库分页、候选字段、关键词截断、元数据搜索、错误响应 |
| `test/fallback.test.js` | 双向跨平台匹配、版本标记规则、503 冷却、429 限流 |
| `test/quota.test.js` | 省请求模式、可播放优先、不可用记忆、缓存过期、超时与网络错误映射 |
| `test/release-seam.test.js` | 源码/产物字节一致、CI 步骤、产物冒烟 |

测试宿主 `test/plugin-host.js` 只注入文档列出的 `splayer`、`URL`、`Promise`、`setTimeout`、`Date` 等全局对象，并按宿主的方式序列化处理器结果，用来模拟真实的插件边界。

## 发布到 SPlayer 插件市场

官方市场投稿入口是 [SPlayer-Dev/plugins 新建插件 Issue](https://github.com/SPlayer-Dev/plugins/issues/new?template=new-plugin.yml)。投稿时选择 `source`，填写 `gdstudio.splayer-source`，上传 `dist/gdstudio.splayer-source.js`，并确认自己对脚本内容和合法性负责。

## 许可与免责声明

本项目代码采用 [MIT 许可证](./LICENSE)。本项目是社区插件，与 SPlayer-Next、GD Studio、网易云音乐、JOOX 均无官方隶属或背书关系。GD Studio API 的使用需遵守其声明的 [CC BY-NC 4.0](https://music-api.gdstudio.xyz/api.php) 许可与平台条款，请注明出处「GD音乐台(music.gdstudio.xyz)」，不要用于商业用途。

<sub>关键词：SPlayer-Next 插件 · 音源插件 · source plugin · 网易云音乐 · JOOX · 无损音乐 · FLAC · 播放地址解析 · 跨平台匹配 · GD Studio API · GD 音乐台 · music source plugin · NetEase Cloud Music</sub>
