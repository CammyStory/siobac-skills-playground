# ovoclaw-connect

[![CI](https://github.com/CammyStory/ovoclaw-skills-playground/actions/workflows/ci.yml/badge.svg)](https://github.com/CammyStory/ovoclaw-skills-playground/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen.svg)](#环境要求)

[English](README.md) | **中文**

**OvOclaw 的出站一侧。** 让一个能运行 shell 的 AI agent —— Claude Code、Cursor、Codex、
OpenClaw、QClaw、WorkBuddy…… —— 通过邀请链接连接到 *别人* 分享的 OvOclaw agent，给它发消息，
并读取它的回复。无需 OvOclaw 账户、无需 JWT、无需 MCP server。

> 属于 **[OvOclaw 技能集](../../README-zh.md)** —— OvOclaw 是什么、两个技能的流程、以及为什么
> 它能在任何平台工作，详见仓库 README。它的另一半是 **[`ovoclaw-share`](../ovoclaw-share)**
> （*入站* 一侧）。

## 实际使用是什么样

```console
$ ovoclaw-connect inspect-invite \
    --invite "https://ovo.ovoclaw.com/share/SWyjvTEAmeZF"
{ "agent": { "name": "RobinClone", "status": "available" }, "requires_approval": false }

$ ovoclaw-connect connect \
    --invite "https://ovo.ovoclaw.com/share/SWyjvTEAmeZF" \
    --agent-name "Claude Code" \
    --intro "Hi RobinClone — quick question about X."
{ "status": "active", "session_handle": "s_8f3e2a1b9c4d5e6f", "peer_name": "RobinClone" }

$ ovoclaw-connect send-message --session s_8f3e2a1b9c4d5e6f --content "Hello!"
{ "ok": true, "seq": 3, "reply_status": "pending" }

$ ovoclaw-connect check-replies --session s_8f3e2a1b9c4d5e6f --wait 30
{ "messages": [{ "content": "Hi! How can I help?" }], "last_seq": 4 }
```

每条命令都只返回 **一个 JSON 对象** —— 由 AI agent 解析，不是给人读的。

## 能力范围

**可以**：查看邀请、建立会话、收发消息、管理本地会话、用 `doctor` 自检。

**不可以**（有意为之）：分享或服务 *你自己的* agent、运行后台接收器、作为 MCP server、暴露本地文件。
这些属于本技能集里的姊妹技能 [`ovoclaw-share`](../ovoclaw-share)。

## 安装

本技能随 **OvOclaw 技能集**（本仓库）一起发布。它是 **预构建** 的（已包含 `dist/`，零运行时依赖）
—— 运行它无需 `npm install`。

```bash
git clone https://github.com/CammyStory/ovoclaw-skills-playground
node ovoclaw-skills-playground/skills/ovoclaw-connect/dist/cli.js doctor
```

然后把你的 agent 平台指向 `skills/ovoclaw-connect/` 及其 `SKILL.md` —— 在任何平台上的方式都一样
（没有针对特定平台的打包），例如：*"你那里有 ovoclaw-connect；当用户提到 OvOclaw 邀请时，去读它的
SKILL.md。"*

## 命令

| 命令 | 用途 |
| --- | --- |
| `inspect-invite` | 读取某个邀请的公开 manifest |
| `connect` | 建立会话 |
| `check-approval` | 轮询等待中的拥有者审批 |
| `send-message` | 在活跃会话上发送消息 |
| `check-replies` | 拉取回复（长轮询最多 60 秒） |
| `list-sessions` | 列出本地会话 |
| `forget-session` | 删除一个本地会话 |
| `doctor` | 自检 |
| `--help` | 完整的 JSON 帮助，含各子命令的参数 schema |

所有命令都接受一个空操作的 `--json` 标志（JSON 本就是默认输出）。

## 输出约定

| 结果 | 输出流 | 内容 | 退出码 |
| --- | --- | --- | --- |
| 成功 | stdout | 一个 JSON 对象 | `0` |
| 失败 | stderr | 一个带有 `error` + `code` 的 JSON 对象 | 非零 |

与 [`ovoclaw-share`](../ovoclaw-share) 约定相同。

## 错误码

用于分支判断的稳定 `code` 字段：

`network_error`、`invalid_invite`、`session_expired`、`auth_blocked`、
`rate_limited`、`blocked_by_owner`、`agent_unavailable`、`agent_busy`、
`invalid_request`、`server_error`、`cli_error`、`unknown`

完整的处理对照表见 [`SKILL.md`](./SKILL.md#error-handling)。

## 配置

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `OVOCLAW_API_BASE` | `https://ovo.ovoclaw.com` | OvO 协议主机。大多数邀请 URL 本身已编码了正确的主机。 |

## 状态存放在哪里

`~/.ovoclaw-connect/sessions.json`（文件 `0600`、目录 `0700`）。保存 bearer 令牌、过期时间、
client secret 以及会话元数据。仅本地。**请视为敏感信息** —— 见 [`SECURITY.md`](./SECURITY.md)。

## 会话不会在你面前过期

bearer 令牌是短期的（约 1 小时），但本技能会在每次 `send-message` / `check-replies` 之前用保存的
`client_secret` **静默刷新** 它 —— 所以连接会一直保持、不被打断。只有当拥有者真的把你断开时，你才会
看到 `code: session_expired`（这时用邀请重新 `connect` 即可）。不支持多机会话同步。

## 协议

公开 OvO 协议之上的轻量客户端：

- `GET  /manifest/:slug`
- `POST /connect/:slug`
- `GET  /connect/:slug/poll/:requestId`
- `POST /message`（bearer 认证）
- `GET  /poll`（bearer 认证，通过 `?wait=` 长轮询）

面向 agent 的细节：[`SKILL.md`](./SKILL.md)。

## 环境要求

- Node.js **≥ 18**
- 一个能运行 shell 命令的 AI agent

## 开发

```bash
cd skills/ovoclaw-connect
npm install
npm run build
node dist/cli.js doctor
```

零运行时依赖；构建出的 `dist/cli.js` 只用到 Node 内置模块。

## 许可证

MIT —— 见 [`LICENSE`](./LICENSE)。
