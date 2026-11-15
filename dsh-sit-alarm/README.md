# dsh-sit-alarm

DSH 插件：久坐提醒。40 分钟专注 + 5 分钟活动，浮动倒计时面板 + Windows 桌面吐司。

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

点右下角小圆片展开面板 →「开始 40 分钟」。之后：

- 第 37 分钟：提醒准备站起来（面板自动展开变色）
- 第 40 分钟：自动进入 5 分钟休息
- 第 45 分钟：休息达标提示，**不自动开始**，点「开始下一轮」才继续

面板可收起成小圆片；专注中显示剩余时间。

## 配置

`~/.dsh/sit-alarm.json`，保存即生效（宿主监听文件，不用重启）：

```json
{ "workMinutes": 40, "warnMinutes": 3, "breakMinutes": 5, "sound": true }
```

## 平台

- 面板：全平台（Web / Electron 的 `shell.overlay` 槽）。
- 桌面吐司：仅 Windows（PowerShell + WinRT，AUMID `com.deepseek.dsh`）；其他平台只跑面板，不弹通知。

## 开发

- `index.js`：Host 状态机、吐司、`/api/sit-alarm` 精确路由（`state` / `command`）
- `client.js`：`shell.overlay` 里的浮动面板，2 秒轮询一次状态
- 改 Host 代码：插件管理里关掉再打开即可重新加载；改 Client 代码需要刷新页面
