# GD Studio API 验证记录

验证时间：2026-10-29（Asia/Shanghai）。所有请求直接发往 `https://music-api.gdstudio.xyz/api.php`，插件实现以此为准。

## 1. 可选来源

| `source` | 搜索 | 结论 |
| --- | --- | --- |
| `netease` | 200，返回数组 | 可用，播放/歌词/封面全部验证通过 |
| `joox` | 200，返回数组 | 搜索、歌词、封面可用；播放返回空地址 |
| `bilibili` | 200，返回 `[]` | 搜索无结果，无法取得 ID |
| `tencent` / `kuwo` / `tidal` / `qobuz` / `apple` / `ytmusic` | 400 | `{"detail":"Value of \`source\` is not supported."}` |
| `spotify` | 503 | Cloudflare 维护页 |

## 2. 播放地址（`types=url`）

网易云曲目 `18902710`（Keyshia Cole – Love，4:15）逐档请求：

| `br` 请求 | 响应 `br` | `size` | 扩展名 |
| --- | --- | --- | --- |
| 999 | 1650 | 52,705,798 | `.flac` |
| 740 | 1650 | 52,705,798 | `.flac` |
| 320 | 320 | 10,218,101 | `.mp3` |
| 192 | 192 | 6,130,878 | `.mp3` |
| 128 | 128 | 4,087,266 | `.mp3` |

结论：

- `740` 与 `999` 返回**同一个文件**，GD Studio 不区分 16/24-bit；响应的 `br` 是文件真实码率。
- 曲目 `274483` 的 `999` / `740` 同为 842kbps FLAC；`1476821` 同为 1124kbps；白噪音曲目 `2094433513` 为 980kbps。
- 曲目 `3388307955` 请求 `999` 时返回 `.flac` 地址但 `br` 只有 293，说明服务端会静默给低码率文件。插件必须按 `br` 上报音质。

不可用音质：任何档位无地址时返回 HTTP 200 + `{"url":"","br":-1,"size":0}`，不是错误状态。

JOOX 曲目 `bLnv0PqDX_qAlIqapc+Okw==`（周杰伦 – 晴天）请求 `999` / `320` / `128` 均返回 `{"url":"","br":-1,"size":0}`；曲目 `MX14hTaB09S4XtuczK40Rg==`（wave to earth – love.）同样为空。2026-10-29 当天 JOOX 播放通道不可用。

## 3. 交付体检

对 `m801.music.126.net` 的 FLAC 地址发 `Range: bytes=0-3`：

```text
range status=206 size=4
get   status=206 ctype=audio/mpeg; charset=UTF-8
```

CDN 支持 Range，返回 206，插件按 2xx 视为可播放。

## 4. 歌词与封面

```json
// types=lyric&source=netease&id=18902710
{"lyric":"[00:00.00] 作词 : Keyshia Cole/Greg Curtis\n…","tlyric":"[by:Angelmusic]\n[00:23.28]我曾以为自己不够好\n…","from":"music.gdstudio.xyz"}

// types=lyric&source=netease&id=99999999999
{"lyric":"[00:00.00]暂无歌词","tlyric":"","from":"music.gdstudio.xyz"}

// types=pic&source=netease&id=109951166033212116&size=300
{"url":"https://p2.music.126.net/W6pyxGzut9zpocd8n5ZsgQ==/109951166033212116.jpg?param=300y300", …}

// types=pic&source=joox&id=7eb1ea63200c510c&size=300
{"url":"https://image.joox.com/JOOXcover/0/7eb1ea63200c510c/300", …}
```

无歌词的曲目返回占位文本 `暂无歌词`，插件把它当作空歌词交给宿主继续尝试其它候选。

## 5. 搜索与分页

- 网易云遵守 `count` / `pages`，`count=2&pages=3` 返回 2 条第 3 页结果。
- JOOX 忽略两个参数，`count=3` 或 `count=5&pages=2` 都返回约 30 条。插件因此改为一次多取、按页切片，避免翻页重复。
- 搜索项字段：`id`、`name`、`artist[]`、`album`、`pic_id`、`url_id`、`lyric_id`、`source`。**没有时长字段**，跨平台匹配不能依赖时长。

## 6. 错误形态

| 场景 | 响应 |
| --- | --- |
| 缺少 `id` | HTTP 400 `{"detail":"Field \`id\` is required."}` |
| 来源未开放 | HTTP 400 `{"detail":"Value of \`source\` is not supported."}` |
| 曲目/音质不可用 | HTTP 200 + 空 `url`、`br: -1` |
| 频率限制 | 文档声明 5 分钟 50 次；插件对 `429` + `Retry-After` 做冷却 |

## 7. 插件端到端验证

用 `test/plugin-host.js` 加载真实插件并对接真实接口（一次运行，9 次请求）：

- `musicSearch(wy, "Love Keyshia Cole")` 返回 3 条带 `picId` / `lyricId` 的候选；
- `musicUrl(wy, hi-res, 18902710)` 返回 1650kbps FLAC，体检 206，上报 `hi-res`；
- `musicLyric(wy, 18902710)` 返回原文歌词与中文翻译；
- `musicPic(wy, picId=109951166033212116)` 返回 `param=500y500` 封面；
- `musicSearch(joox, "晴天")` 返回 3 条带 `picId` / `lyricId` 的候选；
- `musicUrl(joox, hq, 晴天)` 因 JOOX 播放通道为空、网易云又搜不到周杰伦原曲，返回 `GD_TRACK_UNAVAILABLE`。

以上结果与单元测试中的模拟响应一致；未在已安装的 SPlayer-Next 中做整曲播放验收。
