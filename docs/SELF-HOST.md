# 自部署指南

> 💡 用 Claude Code / Cursor 等 AI 编程助手？直接对它说「加载这个仓库，本地部署」，agent 会读 [AGENTS.md](../AGENTS.md) 自动跑完并给你使用命令。

把这份 proxy 跑起来有两种姿势：

- **本地跑**（推荐 · 5 分钟）：自己机器上 `node server.mjs`，免登进 dashboard，直接给本机的 Claude Code 用。
- **服务器部署**（进阶）：放到服务器后面挂域名，给团队共用。

---

## 一、本地运行（5 分钟）

> 目标：clone 代码 → 浏览器打开自动跳 admin dashboard → 拿到 `sk-proxy-xxx` → 配 Claude Code → 调通一句话。
> 不需要任何账号体系；只要你机器上能用 GitHub Copilot 就行。

### 前置条件

1. **Node.js 22+**（用了原生 `fetch` 和 `node:sqlite`）。`node -v` 检查。
2. **GitHub Copilot 订阅**（Business / Enterprise / Individual 都行）。Business 用户需要管理员已经把你加入 seat。
3. 端口 `4819` 没被占用（被占用就改 `PORT`）。

### 步骤

```bash
git clone <repo-url> copilot-anthropic-proxy
cd copilot-anthropic-proxy
npm install            # 没有 runtime 依赖，但脚本可能装 dev 工具
cp .env.example .env   # 本地什么都不用填，直接拷
node server.mjs        # 或 bash start.sh
```

启动日志里会看到一行明显的提示：

```
⚠️  Localhost bypass: ON — loopback callers (127.0.0.1/::1) get implicit admin.
    Set DISABLE_LOCALHOST_BYPASS=1 before exposing this proxy to a network.
```

打开浏览器：<http://127.0.0.1:4819>

— 自动 302 跳到 `/admin`，**不需要任何登录**（loopback 自动认为是 admin）。

### 拿 Copilot token（device flow）

Dashboard 里 → 「Tokens」/「添加 Copilot Token」 → 走 GitHub device flow：

1. 页面会显示一个 8 位 `user code` 和一个跳转链接。
2. 浏览器打开 <https://github.com/login/device>，输入那 8 位 code → 授权 `GitHub for VSCode` 应用（这是 Copilot 官方的 client id）。
3. 回到 dashboard，几秒后状态从 `pending` → `success`，token 已写入本地 `tokens.json`。

> 卡在 `pending`？说明 GitHub 那边还没收到你的授权确认 — 去网页输完 user code 再回来。

### 生成一个 `sk-proxy-xxx`

Device login 完成后，"Login Successful" 面板会自动给出 **Your API Key** 以及
Claude Code / Codex 的整段 `export … && claude` 命令 —— 直接点 Copy 粘到终端就能跑，
不用手动去 Keys 板块建 key 再拼 base_url。

如果想多建几个用于不同项目隔离，再去 Dashboard → 「Keys」→ 「新建 Key」手动建。
**raw key 只在创建时显示一次**，关闭对话框就只剩前缀了。

### 接 Claude Code

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:4819
export ANTHROPIC_AUTH_TOKEN=sk-proxy-你刚才复制的key
claude   # 或者 claude code
```

验证一发：

```bash
curl http://127.0.0.1:4819/v1/messages \
  -H "x-api-key: sk-proxy-你的key" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"claude-sonnet-4-5","max_tokens":64,"messages":[{"role":"user","content":"say hi"}]}'
```

应该看到 Claude 的回复。Dashboard 的「Logs」会出现这条记录。

---

## 二、服务器部署（进阶）

适用场景：放到一台服务器上，挂域名让团队成员共用。

> ⚠️ **第一件事**：设置 `DISABLE_LOCALHOST_BYPASS=1`。否则任何能 SSH 到这台机器、能从本机 `curl 127.0.0.1` 的人（包括其它服务进程）都能拿到 admin 权限。

### 1. 进程管理（二选一）

**systemd**：

```ini
# /etc/systemd/system/copilot-proxy.service
[Unit]
Description=GitHub Copilot → Anthropic proxy
After=network.target

[Service]
WorkingDirectory=/opt/copilot-anthropic-proxy
ExecStart=/usr/bin/node server.mjs
Restart=always
Environment=PORT=4819
Environment=DISABLE_LOCALHOST_BYPASS=1
Environment=TRUST_PROXY=1
EnvironmentFile=-/opt/copilot-anthropic-proxy/.env
User=copilot

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now copilot-proxy
journalctl -u copilot-proxy -f
```

**pm2**：

```bash
DISABLE_LOCALHOST_BYPASS=1 TRUST_PROXY=1 pm2 start server.mjs --name copilot-proxy
pm2 save
pm2 startup    # 跟着提示装开机自启
```

### 2. Caddy 反代 + 自动 HTTPS

```caddyfile
api.example.com {
    reverse_proxy 127.0.0.1:4819
}
```

`caddy reload`，Let's Encrypt 证书自动签发。

> nginx 用户：类似，记得 `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`，proxy 端会跟着 `TRUST_PROXY=1` 取真实 IP。

### 3. 启用微信登录（可选）

```bash
WX_GATEWAY_BASE=https://wx.example.com
WX_GATEWAY_APP_NAME=copilot-proxy
WX_GATEWAY_SECRET=<下发的 secret>
```

详细绑定流程见 [`SPEC-WX-AUTOKEY.md`](../SPEC-WX-AUTOKEY.md)。

### 4. 启用充值/支付（可选）

参见 [`SPEC-WX-PAYMENT.md`](../SPEC-WX-PAYMENT.md)。

### 5. 部署后核对

```bash
# 本机走 loopback（已禁用 bypass）：401
curl -sI http://127.0.0.1:4819/admin/keys

# 公网走域名：401
curl -sI https://api.example.com/admin/keys
```

两条都应该是 401。然后用一个 admin role 的 `sk-proxy-xxx` 验证：

```bash
curl -sI -H "x-api-key: sk-proxy-admin-xxx" https://api.example.com/admin/keys
# 200
```

---

## 三、常见问题

**Q: dashboard 401，但我在本机访问。**
A: 你大概率走了 nginx/Caddy（带 `X-Forwarded-For`）而不是直接 loopback。bypass 检测到反向代理就关掉，是故意的。如果是开发环境想强制 bypass，把 Caddy 关了直连 `127.0.0.1:4819`。

**Q: device flow 一直 pending。**
A: 没有「自动」授权这回事 — 必须在浏览器打开 <https://github.com/login/device> 输入 user code 并点确认。

**Q: 调 `/v1/messages` 报 403 + `copilot_not_eligible`。**
A: 你的 GitHub 账号没拿到 Copilot seat。Business/Enterprise 订阅需要管理员在 GitHub 的 Copilot admin 页面分配。Individual 订阅自己付费即可。

**Q: 端口 4819 被占了。**
A: `PORT=5000 node server.mjs`。Claude Code 那边也要把 `ANTHROPIC_BASE_URL` 改成新端口。

**Q: 用 Docker / 容器跑，loopback bypass 还有效吗？**
A: 容器内进程访问 `127.0.0.1:4819` 当然有效；从宿主机或别的容器访问就不是 loopback 了。如果只在容器内部用，bypass 没问题；如果对外暴露，按服务器部署那套来。

**Q: 我能不能在本地禁掉 bypass，自己用 sk-proxy 登录？**
A: 能。`DISABLE_LOCALHOST_BYPASS=1 node server.mjs`，然后用一个 admin role 的 key 走 `/user/login`。
