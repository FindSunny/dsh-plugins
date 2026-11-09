# 插件市场索引

`index.json` 是 [DSH 插件市场](https://github.com/deepseek-ai) 的 **format 1** 索引：DSH 拉取这个
JSON、用 `@deepseek-ai/dsh-plugin-market-index` 校验，然后列出插件；安装仍走 `pluginManager.installBundle`。

## 发布流程

1. **推送代码**，拿到 commit：

   ```powershell
   git rev-parse HEAD
   ```

2. **生成索引**（会把 commit 写进每个版本）：

   ```powershell
   $env:DSH_MARKET_COMMIT = "<40 位小写 SHA>"
   node market/build-index.cjs
   ```

   想同时校验，先装校验器：

   ```powershell
   pnpm add -D @deepseek-ai/dsh-plugin-market-index
   ```

   没有校验器时脚本只生成、不校验，并打印提示。

3. **提交并推送** `market/index.json`。

4. 用户添加索引 URL：

   ```
   https://raw.githubusercontent.com/FindSunny/dsh-plugins/main/market/index.json
   ```

   （也可以用 GitHub Pages 的地址，只要是无 query / 无 fragment 的 https。）

## 发新版

1. 改 `dsh-notify/package.json`（或 theme 的）里的 `version`；
2. `$env:DSH_MARKET_COMMIT="<新 commit>"`；`node market/build-index.cjs`；提交推送。

脚本会自动把新版本号写进 `versions`，**已列过的版本沿用原来的 `publishTimestamp`**，所以 diff 很小。

## 格式要点（容易踩的）

| 规则 | 说明 |
|---|---|
| `format` | 必须是 `1` |
| `title` / `description` | 多语言对象，**必须含 `en`**；语言键小写 |
| `versions` | 非空；同一版本号不能重复；校验器会按 SemVer 倒序排 |
| `publishTimestamp` | **Unix 秒**整数 |
| `metadata.category` / `labels` / `sortKeys` | 必须先在上层 `metadata.*` 声明，否则 `references undeclared id` |
| `icon` | 内联 `data:`（解码 ≤ 32 KiB），或相对索引 URL 的路径（https 或同源） |
| `source`（git） | `url` 必须是不含 query/fragment 的 https、≥2 段路径；`commit` 是 40 位小写 SHA；`path` 是仓库内子目录 |
| `source`（npm） | `{ "type": "npm" }`，自建 registry 才加 `registry` |

同一版本号只能出现在一个 source 里（npm 和 git 同版本会报 `duplicates`）。

## 默认版本怎么选

DSH 取「**最高的、与当前运行时兼容的、非 prerelease 版本**」；没有正式版时退回最高的 prerelease。
兼容性用各版本的 `engines.dsh` 判断，所以本仓库暂时没写 `engines` —— 以后要限制 DSH 版本再加。
