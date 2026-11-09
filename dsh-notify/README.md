# dsh-notify · 桌面通知

长任务答完后弹一条 Windows 桌面通知。所有会话生效，只在耗时超过阈值的 turn 结束时弹。

## 行为

| turn 结束原因 | 是否通知 |
|---|---|
| 正常答完（`completed`） | 是，且耗时 ≥ 阈值才弹 |
| 出错（`error`） | 是，**不受阈值限制** |
| 撞输出上限（`max-tokens`） | 是，受阈值限制 |
| 被中断（`aborted`） | 默认不弹（可开） |
| 子会话结束（subagent / workflow） | 默认不弹（可开） |
| `blocked` / `interrupted` / `forked` | 不弹 |

文案示例：

```
DSH · 答完了                              ← 标题
刚把插件切回现代吐司，AUMID 换成 com.deepseek.dsh…   ← 回答摘要（可配字数）
桌面通知插件优化 · 用时 6 分 26 秒              ← 会话标题/目录 · 用时
```

**点一下通知 = 把 DSH 主窗口唤到前台**（`activationType="protocol" launch="dsh://open"`）。
托盘气泡同样支持点击（`BalloonTipClicked` → `Start-Process dsh://open`）。

> 只能跳到 DSH，**不能跳到那条具体会话** —— `dsh:` 协议在 shell 里只做 `focusPrimaryWindow()`
> （`lib/main.js` 的 `open-url` / `second-instance` 都不解析 URL 里的会话 id）。要做到按会话跳转，
> 得改 DSH 本体或再加一个自注册协议 + 客户端插件，超出插件能力范围。

## 配置

三处地方，改任意一处都即时生效：

1. **设置 → 插件** 里 `dsh-notify` 那一行的表单（Config schema 自动生成）；
2. 聊天里发语令：
   - `/notify` 或 `/notify status` —— 看当前配置
   - `/notify off` / `/notify on` —— 开关
   - `/notify 90` —— 阈值改 90 秒
   - `/notify test` —— 立刻发一条测试通知，验证通道
3. `~/.dsh/profiles/desktop/cordis.patch.yml` 里 `dsh-notify` 行的 `config`（base 默认值）。

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `thresholdSeconds` | `60` | 阈值 |
| `summaryChars` | `90` | 通知里附的回答摘要字数（取最后一条回答开头，已洗掉 markdown）；`0` = 不附 |
| `channel` | `toast` | `toast` = WinRT 吐司（默认，弹横幅 + 进通知中心）；`balloon` = 托盘气泡（备用，不依赖 AUMID 注册） |
| `sound` | `true` | 提示音 |
| `showIcon` | `true` | 吐司左侧是否显示包内 `icon.png` |
| `notifyOnError` | `true` | 出错弹，且不受阈值限制 |
| `notifyOnAborted` | `false` | 中断也弹 |
| `notifySubagents` | `false` | 子会话也弹 |
| `appId` | `com.deepseek.dsh` | 吐司的 AppUserModelID，**必须是 DSH 注册过的那个**。写 `DSH` 会“收下通知但不弹横幅” |
| `debug` | `false` | 宿主日志打印判定过程 |

## 排查

每次发通知都会写 `~/.dsh/dsh-notify-last.json`：

```json
{ "at": "2026-11-09T02:40:00.000Z", "ok": true, "channel": "winrt", "code": 0, "title": "DSH · 答完了", "body": "用时 2 分 13 秒 · default" }
```

- 文件**不存在** → 事件没收到（插件没激活 / 不满足触发条件），不是通知通道的问题；
- `ok: true, channel: "winrt"` 但你没看到 → 被系统「专注助手 / 勿扰」拦了；
- `channel: "balloon"` → WinRT 吐司发不出去，已降级托盘气泡；
- `ok: false` → powershell 起不来或退出码非 0，看 `code`。

## 实现要点

- 事件：`ctx.on('session/event')` 的 `turn/start` / `turn/end`（`turn/end.data.reason.kind` 区分四种结局）；
  `turn.complete` 那套是 `claudeCodeMods` 的 mod 事件，挂不上，没用。
- 耗时：`turn/start` 到达时记 `Date.now()`；插件装好之前就开着的 turn 用会话日志 `turn/start.time` 兜底。
- 通道：宿主是 `ELECTRON_RUN_AS_NODE=1` 的纯 Node 进程，没有 `electron.Notification`，
  所以 spawn 一次性 `powershell.exe`（`stdio: 'ignore'`）发通知：
  - **默认 WinRT 吐司**，`AppUserModelID` 用 `com.deepseek.dsh`。
    ⚠️ 这是本插件的第一个坑：spec 里写的硬编 `"DSH"` 是个 **Windows 不认识的 AppID**，
    `Show()` 会返回成功、通知也会进通知中心，但**横幅永远不弹**。只有用开始菜单快捷方式
    （`%APPDATA%\Microsoft\Windows\Start Menu\Programs\DeepSeek Harness.lnk`，属性里 AUMID =
    `com.deepseek.dsh`，来自 `app.asar/package.json` 的 `dshDesktopAppId`）注册过的 AUMID 才行。
    声音走 XML `<audio>`（PS 5.1 没 `ToastAudio`）。
  - **备用托盘气泡**（`NotifyIcon.ShowBalloonTip`）：纯 Win32、不需要 AUMID 注册。
    两个必要条件——**消息泵（`DoEvents`）**，否则气泡不渲染；进程要活到气泡消失，所以脚本边泵边等约 10 秒。
  - 吐司 powershell 退出码非 0 时自动换气泡。
- 卸载时 kill 在飞的 powershell，不留僵尸。

## 图标

`icon.png` 出现在两个地方，机制完全不同：

1. **插件列表**（设置 → 插件）：由 `exports["./icon"]` 提供，宿主把 SVG/PNG/JPEG/WebP（≤256 KiB）
   读成 data URL 给界面用。`exports["./locale/*.json"]` 提供 `meta.title` / `meta.description`。
2. **通知上的图标**：Windows 默认只显示 AUMID（要 `com.deepseek.dsh` → DeepSeek Harness）自己的图标，
   跟包里的图无关。所以吐司 XML 里显式写了
   `<image placement="appLogoOverride" src="file:///…/icon.png" />`，才会显示你的 logo。
   托盘气泡通道不支持自定义图标（只能用系统图标），`showIcon` 只作用于吐司。

换图只要替换 `icon.png` 后重载插件；想关掉通知上的图，把 `showIcon` 设为 `false`。

## 已知限制

1. **点击只能唤回 DSH，不能定位到具体会话**（原因见上，`dsh:` 协议不携带会话 id）。
2. 摘要取的是**这一轮最后一条 assistant 消息的开头**：如果回答以表格/代码为主，摘要会偏「公式化」；
   把 `summaryChars` 调大或调 0 可以避开。
