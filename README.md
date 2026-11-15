# dsh-plugins

自己做的 [DeepSeek Harness](https://github.com/deepseek-ai) 插件合集。

| 插件 | 说明 | 平台 |
|---|---|---|
| [`dsh-notify`](./dsh-notify) | 长任务答完弹 Windows 桌面通知：带回答摘要、用时，可点击唤回 DSH；区分答完 / 中断 / 出错；有开关和阈值 | Windows |
| [`dsh-sit-alarm`](./dsh-sit-alarm) | 久坐提醒：40 分钟专注 + 5 分钟活动，右下角浮动倒计时面板，第 37 分钟提醒准备站起，休息结束只提示、不自动开始下一轮 | Windows（面板全平台） |
| [`dsh-theme-mao`](./dsh-theme-mao) | 「人民万岁」主题：老照片背景 + 干净浅色调 | 全平台 |
| [`dsh-theme-lingcage-maiduo`](./dsh-theme-lingcage-maiduo) | 「灵笼 · 麦朵」主题：暖褐 + 玫瑰配色，侧栏人像 + 右侧无缝循环视频（带原创插画兜底） | 全平台 |

## 安装

### 方式一：从插件市场索引安装（推荐）

1. 启用市场（默认关闭）：插件管理器里打开 `@deepseek-ai/dsh-experimental-plugin-market-bundle`；
2. 设置 → 插件 → **Discover** → 添加索引源：

```
https://raw.githubusercontent.com/FindSunny/dsh-plugins/main/market/index.json
```

3. 搜索 `dsh-notify` / `dsh-sit-alarm` / `dsh-theme-mao` 安装。

### 方式二：直接从仓库装

```powershell
# 在插件管理器里填 spec，或命令行
dsh plugin add "git+https://github.com/FindSunny/dsh-plugins.git#<commit>&path:/dsh-sit-alarm"
```

`<commit>` 换成 40 位 SHA（`git rev-parse HEAD`）。换 `path` 就是换插件：`/dsh-notify`、`/dsh-sit-alarm`、`/dsh-theme-mao`。

### 方式三：tgz

Release 里下载 `dsh-notify-x.y.z.tgz`，插件管理器里选该文件。

## 目录结构

```
dsh-notify/       Windows 桌面通知插件（Host-only，ESM）
dsh-sit-alarm/    久坐提醒插件（Host 状态机 + Client 浮层面板）
dsh-theme-mao/    「人民万岁」主题插件
market/
  index.json      插件市场索引（format 1）
  build-index.cjs 索引生成 / 校验脚本
  README.md       索引格式与发布流程说明
```

## 开发

`dsh-notify` 与主题是**纯 Host 插件**，没有构建步骤：改完 `index.js` 重载插件即可（插件管理器里关掉再打开）。

`dsh-sit-alarm` 有 Client 半边（`client.js`，注册在 `shell.overlay` 的浮动面板，2 秒轮询 `/api/sit-alarm`）：
改 Host 代码重载插件即可，改 Client 代码要刷新页面（Ctrl+R）才生效。

`dsh-notify` 声明了 `@deepseek-ai/schemastery` 依赖（用于 Config schema），发布 tgz 时以
`bundledDependencies` 打进包里，因此使用者不需要额外装依赖。

```powershell
cd dsh-notify
pnpm install          # 只为本地开发/打包
pnpm pack             # 产出 dsh-notify-x.y.z.tgz
```

索引：

```powershell
cd market
node build-index.cjs  # 重新生成 index.json 并校验（需要 @deepseek-ai/dsh-plugin-market-index）
```

## License

[MIT](./LICENSE)
