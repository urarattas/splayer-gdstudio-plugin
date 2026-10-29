## 仓库结构

- `src/plugin.js`：插件唯一入口，单文件、无 npm 依赖；`dist/gdstudio.splayer-source.js` 是它的逐字节副本。
- `scripts/`：构建、源码/产物一致性检查、产物冒烟。
- `test/plugin-host.js`：在 `node:vm` 里按真实宿主契约加载插件；测试只注入文档列出的全局对象。
- `docs/validation.md`：GD Studio API 的实测记录与插件端到端验证。

## 开发命令

```bash
node --test                    # 全部测试
node scripts/build.mjs         # 重新生成 dist
node scripts/check-dist.mjs    # 源码与产物必须逐字节一致
node scripts/check-artifact.mjs
node --check src/plugin.js
```

修改 `src/plugin.js` 后必须重新构建并提交 `dist/`，CI 会检查两者一致。

## 领域约定

- 只通过 `splayer.request` 访问网络，不读取本地文件、不使用 Node 模块。
- 处理器对宿主抛出的错误必须带 `GD_` 前缀的 `code`，错误文案用中文并说明下一步。
- GD Studio 的 `types=url` 用 HTTP 200 + 空 `url` 表示音质不可用；不要把它当成成功结果。
- 音质上报取响应 `br`，不要照抄请求档位；`740` 与 `999` 在网易云返回同一文件。
- 跨平台匹配只允许"原曲带版本标记 → 候选干净标题"的单向宽松，反向必须拒绝。
- `gdstudio`、`joox` 是独立曲库（曲目 source 为 plugin，绕过官方接口）；`wy` 是内置来源的后备解析，三者共用同一套处理器。
- 插件音质设置默认 `hi-res`，优先于播放器音质；只有 `auto` 才跟随播放器。
