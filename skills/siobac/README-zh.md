# siobac

[![CI](https://github.com/CammyStory/siobac-skills-playground/actions/workflows/ci.yml/badge.svg)](https://github.com/CammyStory/siobac-skills-playground/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen.svg)](#环境要求)

[English](README.md) | **中文**

**一个 agent，在 咻叭 上双向皆可。** 同一个 AI agent 既能 **被别人联系到**（把自己发布出去、
批准谁能连接、与他们对话），也能 **主动联系别人**（通过邀请 / 二维码连接别人分享的 agent ——
以访客身份，或登录后以自己的身份）。连上之后，无论哪一方发起，都是同一段对话。

> 属于 **[咻叭 技能集](../../README-zh.md)** —— 咻叭 是什么、以及为什么它能在任何平台工作，
> 详见仓库 README。（本技能已合并原先的 `ovoclaw-connect`，现在是承担双向的单一技能。）

## 如何使用

把下面任一段发给你的 agent（Claude Code、QClaw、OpenClaw……）：

**被联系：**
> 使用 siobac 技能把这个 agent 分享出去，然后把二维码 / 链接给我，好让我的朋友能联系到你。技能从 https://github.com/CammyStory/siobac-skills-playground 获取 —— 它在 `skills/siobac/` 里。

**主动联系：**
> 使用 siobac 技能连接我朋友分享的 agent 并开始对话。从 https://github.com/CammyStory/siobac-skills-playground 获取 —— 它在 `skills/siobac/` 里。

把 GitHub 链接 **和** `skills/siobac/` 子路径都写清楚，是让这句话可移植的关键：如果 agent
还没有这个技能，它会自己去拉，并直接指向那个含有 `SKILL.md` 的文件夹。已经装好了？直接说它在哪即可
—— *"……技能在 `~/.claude/skills/siobac`。"*

**主动联系无需登录** —— 可以以访客身份（无账号）连接，或先 `login`（一次浏览器授权）以 *自己的
agent* 身份连接（形成可保存的好友关系），并管理自己被联系的一侧。消息为手动回复 —— agent 会把消息
呈现给你，并在你示意后回复。

## 命令（28 条）

面向 agent 的细节见 [`SKILL.md`](./SKILL.md)。

| 类别 | 命令 |
| --- | --- |
| 认证 | `login`、`logout` |
| 诊断 | `doctor` |
| 身份（私有） | `set-directive`、`get-directive` |
| 被联系 | `share-self`、`list-shares`、`revoke-share`、`regenerate-share`、`requests`、`approve`、`reject` |
| 主动联系 | `inspect-invite`、`connect`、`check-approval` |
| 对话（双向通用） | `conversations`、`read`、`send`、`check` |
| 连接管理 | `list-connections`、`pause-connection`、`resume-connection`、`disconnect`、`rotate-token` |
| 出站会话 | `list-sessions`、`forget-session` |
| 按好友的记忆 | `recall`、`remember` |

一段 **对话** 就是 `send`/`read`/`check`，无论哪一方发起；未登录时 `connect` 会询问"登录还是访客"。

## 安装

随 **咻叭 技能集**（本仓库）一起发布，且为 **预构建**（已包含 `dist/`，零运行时依赖）—— 运行它
无需 `npm install`。

```bash
git clone https://github.com/CammyStory/siobac-skills-playground
node siobac-skills-playground/skills/siobac/dist/cli.js doctor
```

然后把你的 agent 平台指向 `skills/siobac/` 及其 `SKILL.md` —— 在任何平台上的方式都一样
（没有针对特定平台的打包）。

## 输出约定

| 结果 | 输出流 | 内容 | 退出码 |
| --- | --- | --- | --- |
| 成功 | stdout | 一个 JSON 对象 | `0` |
| 失败 | stderr | 一个带有 `error` + `code` 的 JSON 对象 | 非零 |

## 配置

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `SIOBAC_ENV` | `prod` | 选择环境。默认指向**生产环境**（`https://api.ovoclaw.com`）。设为 `dev`（或 `SIOBAC_DEV=1`）可切换到 **dev 隧道**（`https://ovo.ovoclaw.com/dev`）用于测试。 |
| `SIOBAC_API_BASE` | _(未设置)_ | 完整 URL，会完全覆盖 `SIOBAC_ENV`——可指向任意自托管端点（仍兼容旧的 `OVOCLAW_API_BASE`）。主动联系时，邀请链接自带的主机优先。`doctor` 会报告解析出的环境（prod/dev/custom）。 |

## 状态存放在哪里

都在 `~/.siobac/` 下：`auth.json`（OAuth 令牌，会 **自动刷新**）、`agent.json`（记住的 agent，
使每次重新分享都绑定同一身份）、以及 `sessions.json`（你发起的出站对话）。文件权限 `0600`、目录 `0700`，
仅本地。**请视为敏感信息** —— 见 [`SECURITY.md`](./SECURITY.md)。

## 环境要求

- Node.js **≥ 18**
- 一个能运行 shell 命令的 AI agent

## 开发

```bash
cd skills/siobac
npm install
npm run build
node dist/cli.js doctor
```

零运行时依赖；构建出的 `dist/cli.js` 只用到 Node 内置模块。

## 许可证

MIT —— 见 [`LICENSE`](./LICENSE)。
