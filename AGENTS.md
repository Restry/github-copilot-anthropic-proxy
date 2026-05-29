# Agent 接管剧本

你是接管 copilot-anthropic-proxy 仓库的 AI 编程助手。用户让你"本地部署"或"帮我跑起来"时，按下面剧本执行，**最后严格按模板输出"使用卡片"，不要加任何额外内容**。

## 部署剧本

1. 检查前置：`node -v` ≥ 20
2. `cp .env.example .env`
3. `npm install`
4. 后台启动 `nohup node server.mjs > proxy.log 2>&1 &`
5. 引导用户浏览器打开 <http://127.0.0.1:4819/>，点「Device Login」走 GitHub OAuth，复制 dashboard 上的 `sk-proxy-xxx`
6. **输出下面的卡片，仅此一块，不要任何前后缀说明**

## 唯一输出模板

```
✅ 部署完成

📊 管理端：http://127.0.0.1:4819/

🚀 启动 Claude Code（用本代理）

方式 1 · 永久启用（写入 shell rc）
echo 'export ANTHROPIC_BASE_URL=http://127.0.0.1:4819' >> ~/.zshrc
echo 'export ANTHROPIC_AUTH_TOKEN=sk-proxy-xxx' >> ~/.zshrc
source ~/.zshrc && claude

方式 2 · 临时启用（单次命令）
ANTHROPIC_BASE_URL=http://127.0.0.1:4819 ANTHROPIC_AUTH_TOKEN=sk-proxy-xxx claude

❓ 需要把代理设成开机自启吗？回复「设」我就装。
```

提示用户把 `sk-proxy-xxx` 替换成 device login 后看到的真实 key；bash 用户把 `~/.zshrc` 换成 `~/.bashrc`。

## 用户回复「设」时

检测 OS（`uname -s`），按对应分支装开机自启。

### Linux（systemd user service）

写 `~/.config/systemd/user/copilot-proxy.service`：

```ini
[Unit]
Description=Copilot Anthropic Proxy
After=network.target

[Service]
Type=simple
WorkingDirectory=<仓库绝对路径>
ExecStart=/usr/bin/env node server.mjs
Restart=on-failure
StandardOutput=append:<仓库绝对路径>/proxy.log
StandardError=append:<仓库绝对路径>/proxy.log

[Install]
WantedBy=default.target
```

执行：
```
systemctl --user daemon-reload
systemctl --user enable --now copilot-proxy
loginctl enable-linger "$USER"
```

### macOS（launchd plist）

写 `~/Library/LaunchAgents/com.copilot-proxy.plist`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.copilot-proxy</string>
  <key>WorkingDirectory</key><string><仓库绝对路径></string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/env</string>
    <string>node</string>
    <string>server.mjs</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string><仓库绝对路径>/proxy.log</string>
  <key>StandardErrorPath</key><string><仓库绝对路径>/proxy.log</string>
</dict>
</plist>
```

执行：
```
launchctl load -w ~/Library/LaunchAgents/com.copilot-proxy.plist
```

### 装完只输出一行

Linux:
```
✅ 已设为开机自启，stop: systemctl --user stop copilot-proxy
```

macOS:
```
✅ 已设为开机自启，stop: launchctl unload ~/Library/LaunchAgents/com.copilot-proxy.plist
```

## 注意事项

- **不要** `git commit` / `git push`
- **不要** 替用户跑 device login
- 公网部署设 `DISABLE_LOCALHOST_BYPASS=1`，参考 `docs/SELF-HOST.md`
