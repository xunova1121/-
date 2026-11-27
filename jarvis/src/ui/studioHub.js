import { WORKFLOW_PRESETS } from '../agent/workflowPresets.js';
import './studioLibrary.css';
export const studioNode = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter(Boolean));
  return node;
};
export function studioButton(text, run, className = '') {
  const button = studioNode('button', { type: 'button', textContent: text, className });
  button.addEventListener('click', run);
  return button;
}
/** 广场只读短列表，进入作品再读取文件；不在浏览时请求生成模型。 */
export function createStudioHub({ open, workflow, check, pick, resume, toast }) {
  const recent = studioNode('div', { className: 'wy-hub-recent' });
  const works = studioNode('div', { className: 'wy-hub-resume' });
  const safe = (fn) => async () => {
    try {
      await fn();
    } catch (error) {
      toast(error.message);
    }
  };
  const root = studioNode(
    'section',
    { className: 'wy-hub', ariaLabel: '创作工作台' },
    studioNode(
      'div',
      { className: 'wy-hub-shortcuts' },
      ...[
        ['works', '我的作品'],
        ['templates', '我的模板'],
        ['team', '团队共享'],
        ['brand', '品牌样式']
      ].map(([id, label]) =>
        studioButton(
          label,
          safe(() => open(id))
        )
      )
    ),
    works,
    recent,
    studioNode(
      'details',
      { className: 'wy-hub-workflows' },
      studioNode('summary', { textContent: '创作流程与能力检查' }),
      studioNode(
        'div',
        { className: 'wy-hub-flows' },
        studioNode('strong', { textContent: '一步开始，分步完成' }),
        ...WORKFLOW_PRESETS.map((p) =>
          studioButton(
            p.name,
            safe(() => workflow(p.id))
          )
        )
      ),
      studioButton('检查当前能力', safe(check), 'wy-hub-check')
    )
  );
  return {
    root,
    render({ profiles = [], preferences, files = [], sessions = [] } = {}) {
      recent.replaceChildren();
      const used = (preferences?.recent || [])
        .map((id) => profiles.find((p) => p.id === id))
        .filter(Boolean)
        .slice(0, 4);
      if (used.length)
        recent.append(
          studioNode('small', { textContent: '最近使用' }),
          ...used.map((p) =>
            studioButton(
              p.name,
              safe(() => pick(p))
            )
          )
        );
      works.replaceChildren();
      const last = sessions.find((s) => s.agentId && (s.count > 0 || s.messages?.length > 0));
      if (last)
        works.append(
          studioNode('span', { textContent: '继续上次 · ' + last.title }),
          studioButton(
            last.taskStatus === 'running' ? '查看进度' : '继续对话',
            safe(() => resume(last.id))
          )
        );
      else if (files.length)
        works.append(
          studioNode('span', { textContent: '继续作品 · ' + files[0].path.split('/').pop() }),
          studioButton(
            '打开作品',
            safe(() => open('works'))
          )
        );
    }
  };
}
