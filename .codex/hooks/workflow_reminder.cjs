'use strict';

const context = [
  '项目流程提醒：细则见根 AGENTS.md，以及 docs/agents/workflow.md、engineering.md、quality-gates.md。',
  '- 纯展示或文档改动说明位置、依据和验收，不制造业务流程图、service 或 API。',
  '- 改变用户行为前，确认匹配版本的真人批准开工卡，保留范围、流程图、影响模块、复用或新增 service/API、BDD 和关键失败测试草稿。',
  '- 权限、账本、任务状态与重试、迁移、上传、供应商调用和部署属于高风险，补数据保护、回滚、专项验证和独立复核。',
  '- 保留已有项目规则和用户改动。Hook 只恢复提醒，不代替批准、复核、测试或客户端信任。',
].join('\n');

function readEvent() {
  try {
    return JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
  } catch {
    return null;
  }
}

function shouldRemind(event) {
  if (!event) return false;
  if (event.hook_event_name === 'SessionStart') return true;
  if (event.hook_event_name === 'UserPromptSubmit') return true;
  if (!['PreToolUse', 'PostToolUse'].includes(event.hook_event_name)) return false;
  if (/^(apply_patch|edit|write|notebookedit|str_replace_editor)$/i.test(event.tool_name || ''))
    return true;
  if (!/^(bash|powershell|pwsh)$/i.test(event.tool_name || '')) return false;

  const command = event.tool_input?.command;
  if (typeof command !== 'string') return false;
  return /(?:\bgit\s+(?:add|commit|push|merge|cherry-pick|revert|apply)\b|\b(?:apply_patch|Set-Content|Add-Content|Out-File|Remove-Item|Move-Item|Copy-Item|New-Item)\b|\bsed\s+-i\b|\btee\b|\b(?:write_text|write_bytes|writeFileSync|unlinkSync|rmdirSync)\b|(?:^|[\s\d])(?:>>|>)(?!=)|\b(?:pnpm\s+(?:add|install|remove|update)|uv\s+(?:add|remove))\b)/i.test(
    command,
  );
}

function run() {
  const event = readEvent();
  if (shouldRemind(event)) {
    process.stdout.write(
      `${JSON.stringify({ hookSpecificOutput: { hookEventName: event.hook_event_name, additionalContext: context } })}\n`,
    );
  }
}

module.exports = { context, run, shouldRemind };
if (require.main === module) run();
