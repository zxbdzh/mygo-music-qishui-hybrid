# 项目工作指引

本仓库是 `lane128/mygo-music-qishui` 的个人 fork（`zxbdzh/mygo-music-qishui-hybrid`）。
上游的 `CLAUDE.md` 已删除，规则入口统一到本文件；同步 upstream 时若 `CLAUDE.md` 被带回来，直接删除，不要恢复。

涉及本项目的调查、开发修复、验证、自测打包、提交推送、GitHub 发布、发布文案 / 仓库元数据或旧产物清理时，先读取并遵循 [.claude/skills/qishui-iteration/SKILL.md](.claude/skills/qishui-iteration/SKILL.md)；也可显式调用 `/qishui-iteration`。

版本准备、打包、提交或发布仍须读取 [RELEASE.md](RELEASE.md)，按其中的流程和检查范围执行。Skill 不替代操作授权；提交、推送、发布和删除按用户明确授权执行，同一任务已授权的步骤不重复询问。

<!-- project-workflow:start -->
## Agent workflow

开工卡、工程规则和质量门槛见 `docs/agents/workflow.md`、`docs/agents/engineering.md`、
`docs/agents/quality-gates.md`；Agent 提醒 Hook 见 `docs/agents/agent-hooks.md`。
项目已有规则优先，行为改动须先取得匹配版本的真人批准。
<!-- project-workflow:end -->

## Agent skills

### Issue tracker

待办与缺陷记在本仓库的 GitHub Issues（用 `gh` 操作），见 `docs/agents/issue-tracker.md`。

### Domain docs

单上下文：仓库根一份 `GLOSSARY.md` 加 `docs/adr/`，见 `docs/agents/domain.md`。
