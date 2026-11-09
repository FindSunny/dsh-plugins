# dsh-plugins

自己做的 [DeepSeek Harness](https://github.com/deepseek-ai) 插件合集。

| 插件 | 说明 | 平台 |
|---|---|---|
| [`dsh-notify`](./dsh-notify) | 长任务答完弹 Windows 桌面通知：带回答摘要、用时，可点击唤回 DSH；区分答完 / 中断 / 出错；有开关和阈值 | Windows |
| [`dsh-theme-mao`](./dsh-theme-mao) | 「人民万岁」主题：老照片背景 + 干净浅色调 | 全平台 |

## 安装

### 方式一：从插件市场索引安装（推荐）

1. 启用市场（默认关闭）：插件管理器里打开 `@deepseek-ai/dsh-experimental-plugin-market-bundle`；
2. 设置 → 插件 → **Discover** → 添加索引源：

```
https://raw.githubusercontent.com/FindSunny/dsh-plugins/main/market/index.json
```

3. 搜索 `dsh-notify` / `dsh-theme-mao` 安装。

### 方式二：直接从仓库装

```powershell
# 在插件管理器里填 spec，或命令行
dsh plugin add "git+https://github.com/FindSunny/dsh-plugins.git#<commit>&path:/dsh-notify"
```

### 方式三：tgz

Release 里下载 `dsh-notify-x.y.z.tgz`，插件管理器里选该文件。

## 目录结构

```
dsh-notify/       Windows 桌面通知插件（Host-only，ESM）
dsh-theme-mao/    「人民万岁」主题插件
market/
  index.json      插件市场索引（format 1）
  build-index.cjs 索引生成 / 校验脚本
  README.md       索引格式与发布流程说明
```

## 开发

两个插件都是**纯 Host 插件**，没有构建步骤：改完 `index.js` 重载插件即可（插件管理器里关掉再打开）。

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
