# 灵笼 · 麦朵「暖夜」

给 DeepSeek Harness 换一套《灵笼2》乌兰麦朵气质的主题：

- **侧栏**：她的一张静帧人像（运行时按侧栏真实宽度自适应，收成 rail 也会跟随）；
- **右侧工作区**：10 秒循环背景视频（首尾做过交叉溶解，循环点几乎看不出接缝）；
- **配色**：从壁纸取色的暖褐底 + 玫瑰主色 + 暖琥珀强调；代码块另给了不透明的近黑；
- **兜底**：仓库里还带一张**原创矢量插画**（灯塔 + 背光双枪剪影），没有本地素材时自动启用。

## 装

插件管理器里安装 `dsh-theme-lingcage-maiduo`，或从本仓库的[市场索引](../market/index.json)里搜；
启用后**重启 DSH**（桌面版的主题行是启动时随 IPC 下发的，菜单里的「刷新页面」不够）。

> 主题类插件同时只该开一个：`dsh-theme-mao`、`dsh-theme-lingcage-maiduo` 会各自注入一段
> `style`，同时开会互相覆盖。切换 = 关一个开一个。

## 两层素材

| 文件 | 作用 |
|---|---|
| `theme.local.css` | **本地版**：人像条 + 暖色令牌（由 `theme.local.extra.css` + 模板生成） |
| `assets/background.local.jpg` | 侧栏人像原图（压到 1920×1080） |
| `assets/background.loop.mp4` | **实际播放**的循环视频（ffmpeg 首尾 1s 交叉溶解，9 秒） |
| `assets/background.local.mp4` | 原始素材（保留，便于重新生成循环版） |
| `theme.css` + `assets/background.svg` | **公开兜底版**：原创矢量插画 + 冰蓝/余烬配色 |

插件加载顺序：有 `theme.local.css` 用它，否则退回 `theme.css`。
视频只在这一层存在：`background.loop.mp4`（或原片）经 `/theme-maiduo/v2/bg.mp4` 路由提供给页面。

## 配色

| 角色 | 颜色 |
|---|---|
| 底色 | `#120e0c` / `#2c1f18` 暖褐黑 |
| 主色 | 玫瑰 `#e0939a`（按钮、链接、激活态、选区） |
| 强调 | 暖琥珀 `#e8a06a`（用户气泡、警告、主行动按钮） |
| 代码块 | `rgb(9,7,6)` 不透明（避免被视频叠色洗成暖褐） |
| 成功 / 错误 | 冷青 `#57c39c` / 信号红 `#ff6b5c` |

## 改

| 想改什么 | 改哪里 |
|---|---|
| 配色 / 透明度 | `theme.local.extra.css`（`!important` 覆盖，后加载者胜） |
| 覆盖层浓度 | `theme.local.css` 顶部 `--dsh-maiduo-video-opacity`（默认 0.42） |
| 人像条宽度兜底 | `theme.local.css` 顶部 `--dsh-maiduo-strip`（默认 248px，启动后由 `fit-sidebar.js` 实测覆盖） |
| 视频起止 / 循环点 | `assets/background.local.mp4` → 用 ffmpeg 重新生成 `background.loop.mp4` |
| 生效 | `node build-css.cjs`（公开版）+ `node build-local-css.cjs`（本地版）→ 重载插件 → 重启 DSH |

生成物（`theme.css` / `theme.local.css`）不要手改，改模板后重跑构建脚本。

## 结构

```
index.js              Host 插件：style 行 + html 行（<video>）+ 内联 script 行（播放/量宽）
boot.js               视频播放器：接管播放、失败退避重试、回执到 /theme-maiduo/v2/ack
fit-sidebar.js        量出侧栏真实宽度写进 --dsh-maiduo-strip
theme.template.css    公开版样式源（含 __BG_DATA_URI__ 占位）
theme.css             公开版生成物（插件读取的第二顺位）
theme.local.extra.css 本地版配色覆盖
theme.local.css       本地版生成物（插件读取的第一顺位）
assets/               插画、原图、原视频、循环视频
build-css.cjs         生成 theme.css
build-local-css.cjs   生成 theme.local.css（内联人像 + 追加本地配色）
preview.html          静态预览（模拟 DSH 布局）
```

## 许可与素材

代码 MIT。

主题里的**壁纸与视频素材版权归原方**（《灵笼》相关作品 / 壁纸站点），这里仅作者个人自用、
未作商用；若要公开发布或商用，请自行替换为你有权使用的素材。`assets/background.svg` 是本仓库原创。
