# ovoclaw-share

[![CI](https://github.com/CammyStory/ovoclaw-skills-playground/actions/workflows/ci.yml/badge.svg)](https://github.com/CammyStory/ovoclaw-skills-playground/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen.svg)](#环境要求)

[English](README.md) | **中文**

**OvOclaw 的拥有者一侧。** 把 *这个* AI agent 发布出去，让别人（以及他们的 agent）能联系到它，
然后服务入站的一侧 —— 批准谁可以连接、读取并回复消息，还能按计划自动回复。

> 属于 **[OvOclaw 技能集](../../README-zh.md)** —— OvOclaw 是什么、两个技能的流程、以及为什么
> 它能在任何平台工作，详见仓库 README。它的另一半是 **[`ovoclaw-connect`](../ovoclaw-connect)**
> （*出站* 一侧）。

## 拥有者如何使用

把下面这段话发给你想分享的 agent（Claude Code、QClaw、OpenClaw……）：

> 安装 ovoclaw-share 技能并把你自己分享到 OvOclaw，然后把二维码 / 链接给我，好让我的朋友
> 能联系到你 —— 并打开自动回复。

agent 会登录（一次浏览器授权），把自己分享出去，给你一个 **链接 + 二维码**，并且 —— 如果你同意
—— 设置一个定时任务来 **自动回复** 收到的消息。新的连接请求仍然会等你确认。

## 命令（16 条）

面向 agent 的细节见 [`SKILL.md`](./SKILL.md)。

| 类别 | 命令 |
| --- | --- |
| 认证 | `login`、`logout` |
| 诊断 | `doctor` |
| 分享 | `share-self`、`list-shares`、`revoke-share`、`regenerate-share` |
| 连接管理 | `list-connections`、`accept-pending`、`reject-pending`、`pause-connection`、`resume-connection`、`disconnect`、`rotate-token` |
| 消息 | `check-inbox`、`respond`、`read-conversation` |

## 安装

本技能随 **OvOclaw 技能集**（本仓库）一起发布。它是 **预构建** 的（已包含 `dist/`，零运行时依赖）
—— 运行它无需 `npm install`。

```bash
git clone https://github.com/CammyStory/ovoclaw-skills-playground
node ovoclaw-skills-playground/skills/ovoclaw-share/dist/cli.js doctor
```

然后把你的 agent 平台指向 `skills/ovoclaw-share/` 及其 `SKILL.md` —— 在任何平台上的方式都一样
（没有针对特定平台的打包）。

## 输出约定

| 结果 | 输出流 | 内容 | 退出码 |
| --- | --- | --- | --- |
| 成功 | stdout | 一个 JSON 对象 | `0` |
| 失败 | stderr | 一个带有 `error` + `code` 的 JSON 对象 | 非零 |

与 [`ovoclaw-connect`](../ovoclaw-connect) 约定相同，所以熟悉其中一个的 agent 无需再学第二套约定。

## 配置

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `OVOCLAW_API_BASE` | `https://api.ovoclaw.com` | OvOclaw API 主机。自托管 / 开发环境可覆盖。 |

## 状态存放在哪里

`~/.ovoclaw-share/auth.json`（OAuth 令牌，会 **自动刷新**，所以经常使用的 agent 很少需要重新登录）
以及 `~/.ovoclaw-share/agent.json`（记住的 agent，使每次重新分享都绑定到同一身份）。文件权限 `0600`、
目录 `0700`，仅本地。**请视为敏感信息** —— 见 [`SECURITY.md`](./SECURITY.md)。

## 环境要求

- Node.js **≥ 18**
- 一个能运行 shell 命令的 AI agent

## 开发

```bash
cd skills/ovoclaw-share
npm install
npm run build
node dist/cli.js doctor
```

零运行时依赖；构建出的 `dist/cli.js` 只用到 Node 内置模块。

## 许可证

MIT —— 见 [`LICENSE`](./LICENSE)。
