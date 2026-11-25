import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import workflow from '../.codex/hooks/workflow_reminder.cjs';

const root = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
export const name = `project-workflow-${path.basename(root).toLowerCase()}`;
export const inject = ['systemPrompt'];

function appliesTo(cwd) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return false;
  try {
    const relative = path.relative(root, realpathSync(cwd));
    return relative === '' || (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' && !path.isAbsolute(relative));
  } catch {
    return false;
  }
}

export function apply(ctx) {
  // 每次请求重新装配提醒，避免压缩历史后丢失项目入口。
  ctx.systemPrompt.section({
    name,
    order: 650,
    text: ({ agent }) => appliesTo(agent?.session?.header?.cwd) ? workflow.context : '',
  });
}
