# Agent 提醒 Hook

项目规则正文由根 `AGENTS.md` 及 `docs/agents/` 维护。Hook 只在会话启动、恢复、压缩、用户提示或写入前重新提醒入口和批准边界。

## 文件入口

| 客户端 | 项目文件 |
| --- | --- |
| Codex | `.codex/hooks.json`、`.codex/hooks/workflow_reminder.cjs` |
| Claude Code | `.claude/settings.json` |
| Pi | `.pi/extensions/workflow-reminder.ts` |
| DSH | `.dsh/workflow-reminder.mjs`、`.dsh/workflow.patch.yml` |

## 生效条件

- 文件存在只证明已安装，不证明客户端已经加载。
- Codex 需要在 `/hooks` 审阅并信任项目 Hook。
- Claude Code、Pi 和 DSH 按各自客户端的项目授权、扩展和重载机制确认。
- Hook 失效时仍以仓库文档为准，不因提醒缺失改变授权边界。

安装或更新后，报告每个客户端是已验证、未验证还是未启用。不要把历史会话仍在运行当作新 Hook 已加载。

## 本仓库安装状态

| 客户端 | 状态 | 说明 |
| --- | --- | --- |
| Claude Code | 已安装，未验证 | `.claude/settings.json` 在 SessionStart / UserPromptSubmit / PreToolUse 调用提醒脚本 |
| Codex | 已安装，未验证 | 需在 `/hooks` 里审阅并信任后生效 |
| DSH | 已安装，未验证 | `.dsh/workflow.patch.yml` 插入 `./workflow-reminder.mjs`，需重载客户端 |
| Pi | 未安装 | 本仓库未使用 Pi |

提醒脚本单一来源是 `.codex/hooks/workflow_reminder.cjs`；DSH 的 `.dsh/workflow-reminder.mjs` 直接引用它，不要复制出第二份正文。
