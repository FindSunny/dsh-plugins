# dsh-sit-alarm

DSH 插件：久坐提醒。40 分钟专注 + 5 分钟活动，浮动倒计时面板 + Windows 桌面吐司 + 今日统计。

## 安装

**从仓库装（推荐，另一台电脑用这个）：**

```powershell
dsh plugin add "git+https://github.com/FindSunny/dsh-plugins.git#<commit>&path:/dsh-sit-alarm"
```

`<commit>` 是 40 位 SHA。也可以在插件市场里添加索引后搜索 `久坐提醒`：

```
https://raw.githubusercontent.com/FindSunny/dsh-plugins/main/market/index.json
```

**本地目录装：** 设置 → 插件 → 添加插件，选这个目录。

装完**刷新页面**（Ctrl+R），右下角出现小圆片。

## 使用

卡片在左侧边栏底部、用户名上方（和工作区不抢地方）。点「开始 40 分钟」，之后：

- 第 37 分钟：提醒准备站起来（卡片自动展开变色）
- 第 40 分钟：吐司「专注完成」，卡片停住等你点「开始休息」
- 点「开始休息」后：5 分钟休息开始倒计时
- 休息结束前 1 分钟：预告
- 第 45 分钟：休息达标，**同样停住**，点「开始下一轮」才继续

专注和休息之间、休息和下一轮之间都要人点一下，不会自动跳。

卡片可收起成一行摘要；侧栏折成 rail 时显示 ⏱ 按钮。底部一行是今天的统计：`今日 N 轮 · 专注 M 分`。

## 配置

`~/.dsh/sit-alarm.json`，保存即生效（宿主监听文件，不用重启）：

```json
{ "workMinutes": 40, "warnMinutes": 3, "breakMinutes": 5, "breakWarnMinutes": 1, "sound": true }
```

统计落在 `~/.dsh/sit-alarm-stats.json`，按本地日期分桶，保留 45 天。

## 平台

- 面板：全平台（Web / Electron 的 `shell.overlay` 槽）。
- 桌面吐司：仅 Windows（PowerShell + WinRT，AUMID `com.deepseek.dsh`）；其他平台只跑面板，不弹通知。

## 开发

- `index.js`：Host 状态机、吐司、统计、`/api/sit-alarm` 精确路由（`state` / `command`）
- `client.js`：注册在 `sidebar.footer.action` 的侧栏卡片，2 秒轮询一次状态
- 改 Host 代码：插件管理里关掉再打开即可重新加载；改 Client 代码需要刷新页面
