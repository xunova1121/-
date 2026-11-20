import * as workspace from './workspace.js';
import { collection, scopedState } from './store.js';
import { trashSnapshot } from './workspaceTrash.js';
import { throwControl } from '../core/networkRequest.js';

const MAX_FILES = 20;
const TTL = 30 * 60000;
const pendingBySession = scopedState('files', () => new Map());
const choose = '回复文件名或序号，也可以指定日期或关键词缩小范围。';
const bulkQuestion = '回复「确认全部移入回收站」执行这份清单，或回复「取消」。';
const bulkConfirm = /^确认全部移[入到至]回收站[。！!]?$/;
const question = '回复「确认删除文件」将上面的文件移至回收站，或回复「取消」。';
const confirm = /^(?:确认删除(?:这些|这批)?(?:文件)?|确定删除(?:文件)?|确认|确定|删吧|确认移至回收站)[。！!]?$/;
const cancel = /^(?:取消(?:删除)?|不要删(?:了)?|不删(?:了)?)[。！!]?$/;
// 没有给出文件名、明确清单或日期范围时，“以前”“所有”不能让模型替用户挑选。
function vagueRemoval(text) {
  if (!text || text.length > 55 || !text.includes('文件') || !/删|清理|销毁|移至回收站/.test(text)) return false;
  const qualifiers = text.replace(/文件空间|移至回收站|工作区|我的|我想|我要|帮我|里面|以前|之前|历史|过去|那些|这些|所有|全部|一下|一批|一些|文件|删除|删掉|清理|销毁|真实|未央|[请想把将我的里中旧老都全先给删掉了，,。！!\s]/gu, '');
  return !qualifiers;
}
// 仅完整、明确的整空间命令触发；目录、年份、扩展名及“以前”等限定都保留为选取条件。
function wholeSpaceRemoval(text) {
  if (!text || text.length > 90 || !/清空|清除|删除|删掉|删了|全删|清理|移(?:动)?[入到至](?:文件空间)?回收站/.test(text)) return false;
  if (!/文件|工作区|工作空间/.test(text) && !/^(?:把)?(?:全部|所有|全都)移(?:动)?[入到至]回收站[。！!]?$/u.test(text)) return false;
  if (!/所有|全部|全都|全删|都删|清空/.test(text)) return false;
  return !text.replace(/文件空间|工作空间|工作区|回收站|请帮我|我想|我要|帮我|未央|当前|全部|所有|全都|文件|清空|清除|删除|删掉|删了|清理|移动到|移入|移到|移至|本机|设备上|云端|云服务器|服务器|[请把我想将的里中在全都给删掉了，,。！!\s]/gu, '');
}
const invalid = message => Object.assign(new Error(message), { code: 'WORKSPACE_TRASH_INPUT', kind: 'input' });
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const pathField = { type: 'string', minLength: 1, description: '文件空间中实际存在的完整相对路径' };

// 文件名是数据。避免清单里的换行、链接、强调等把真实路径伪装成另一项。
const label = path => String(path).replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, '�').replace(/[\\`*_#[\]<>|]/g, '\\$&');
const date = t => new Date(t).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
const describe = file => label(file.path) + '（' + date(file.mtime) + '，' + file.size + ' 字节）';
const previewText = items => '准备移至文件空间回收站的文件：\n\n' + items.map(f => '- ' + describe(f)).join('\n') + '\n\n' + question;

function remember(sessionId, selection) {
  const pending = pendingBySession();
  const at = Date.now();
  for (const [key, value] of pending) if (at - value.at > TTL) pending.delete(key);
  if (pending.size >= 64) pending.delete(pending.keys().next().value);
  pending.set(sessionId, { at, ...selection });
}

const assertWorkspace = ws => { if (ws.mode() === 'folder') throw invalid('当前连接的是设备文件夹。请切回未央文件空间，或在设备的文件管理器中操作。'); };
function checkedPath(path) {
  if (typeof path !== 'string' || !path || path.length > 500 || /\p{Cc}/u.test(path)) throw invalid('请提供文件列表中的完整相对路径。');
  return path;
}
export function createWorkspaceTrashTools(ws = workspace) {
  const prepare = {
    name: 'prepare_file_trash',
    description: '用户要删除未央文件空间中的旧文件时使用。范围不明确则不传路径，列出真实候选供选择；按名称可先 find_files。只提交用户选定的准确路径，向用户展示清单，下一条确认才移动。不要用代码清空文件。',
    input_schema: schema({ paths: { type: 'array', items: pathField, minItems: 1, maxItems: MAX_FILES } }),
    run: async ({ paths } = {}, { sessionId, rawRequestText } = {}) => {
      assertWorkspace(ws);
      if (!sessionId) throw invalid('请在要管理文件的对话中操作。');
      const pending = pendingBySession();
      pending.delete(sessionId);
      const active = await ws.list();
      const request = String(rawRequestText || '').trim();
      if (wholeSpaceRemoval(request)) {
        const cloud = Boolean(collection('files').bind().scopeKey);
        const location = cloud ? '当前账号的云端文件空间' : '本机的未央文件空间';
        if (cloud && /本机|设备上/.test(request) || !cloud && /云端|服务器/.test(request)) return '当前使用' + location + '，请切换到目标文件空间后再操作。';
        if (!active.length) return location + '已是空的。';
        const items = active.map(({ path, size, mtime }) => ({ path, size, mtime }));
        const examples = items.slice(0, 6).map(f => '- ' + describe(f)).join('\n');
        const text = '准备将' + location + '中的全部 ' + items.length + ' 个活动文件移至回收站，范围包含上传文件、成品和过程文件。确认后仍可恢复。\n\n' +
          (items.length > 6 ? '前 6 个文件：\n' : '') + examples + '\n\n' + bulkQuestion;
        remember(sessionId, { items, bulk: true, text });
        return text;
      }
      if (!paths || vagueRemoval(request)) {
        const candidates = active.filter(f => !/(?:^|\/)(?:文档检查|\.workflows|\.checkpoints|检查记录)\//.test(f.path));
        if (!candidates.length) return '当前文件空间没有可列出的普通文件。';
        const oldest = candidates.sort((a, b) => a.mtime - b.mtime || a.path.localeCompare(b.path)).slice(0, 12);
        const text = '请选择要删除的文件。按修改时间从早到晚，列出 ' + oldest.length + ' 个，共 ' + candidates.length + ' 个：\n\n' +
          oldest.map((f, i) => (i + 1) + '. ' + describe(f)).join('\n') + '\n\n' + choose;
        remember(sessionId, { choices: oldest.map(f => f.path), text });
        return text;
      }
      if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_FILES) throw invalid('一次请选择 1 到 20 个文件。');
      const files = new Map(active.map(f => [f.path, f]));
      const items = [...new Set(paths.map(checkedPath))].map(path => {
        const item = files.get(path);
        if (!item) throw invalid('活动文件中没有这个完整路径：' + path + '。请先查找或让用户选择。');
        return { path, size: item.size, mtime: item.mtime };
      });
      const text = previewText(items);
      remember(sessionId, { items, text });
      return text;
    },
    // 只有引擎收到下一条真实用户确认后才能进入；模型只看得到上方预览工具。
    async finishPreview({ sessionId, previous, cancelled, signal, emit }) {
      const pending = pendingBySession();
      const draft = pending.get(sessionId);
      if (!draft?.items || Date.now() - draft.at > TTL || !previous.endsWith(draft.text)) {
        return { text: '这份文件清单已失效，请重新选择要删除的文件。', toolCalls: 0 };
      }
      pending.delete(sessionId);
      if (cancelled) return { text: '已取消，文件仍在原处。', toolCalls: 0 };
      const started = Date.now();
      const name = 'trash_files';
      const id = 'workspace-trash';
      const args = draft.bulk ? { scope: 'all', total: draft.items.length } : { paths: draft.items.map(f => f.path) };
      emit({ type: 'tool_start', id, name, args });
      const { paths, errors } = await trashSnapshot(draft.items, {
        signal,
        trashFile: (path, expected) => { assertWorkspace(ws); return ws.trash(path, expected); },
        onProgress: ({ done, total }) => { if (draft.bulk && (done % 20 === 0 || done === total)) emit({ type: 'tool_progress', id, text: '已核对 ' + done + ' / ' + total + ' 个文件' }); }
      });
      const status = errors.length ? (paths.length ? 'partial' : 'failed') : 'trashed';
      const output = JSON.stringify({ changedCount: paths.length, status, paths: paths.slice(0, 50), errors: errors.slice(0, 50), failedCount: errors.length });
      emit({ type: 'tool_end', id, name, ok: !errors.length, output, ms: Date.now() - started });
      const text = [
        ...(paths.length ? [(draft.bulk ? paths.length + ' 个文件' : '') + '已移至文件空间回收站，可在「文件空间 → 回收站」恢复。', ...(!draft.bulk || paths.length <= 6 ? paths.map(p => '- ' + label(p)) : [])] : []),
        ...(errors.length ? [errors.length + ' 个未移入回收站的文件' + (errors.length > 20 ? '（列出前 20 个）' : '') + '：', ...errors.slice(0, 20).map(e => '- ' + label(e.path) + '：' + label(e.reason))] : [])
      ].join('\n');
      return { text, toolCalls: 1 };
    }
  };
  return [
    prepare,
    {
      name: 'list_trashed_files',
      description: '查看当前文件空间回收站，返回实际路径、大小、移入时间。可按名称或目录过滤。',
      input_schema: schema({ query: { type: 'string', description: '可选，完整路径包含的文字' } }),
      run: async ({ query = '' } = {}) => {
        assertWorkspace(ws);
        const files = (await ws.listTrash()).filter(f => f.path.includes(query));
        return JSON.stringify({ total: files.length, files: files.slice(0, 50), more: files.length > 50 });
      }
    },
    {
      name: 'restore_file',
      description: '用户要求恢复时，把当前文件空间回收站中指定的一个文件放回原位置；先列回收站确认路径，原位置有同名文件时保留两者并告知冲突。',
      input_schema: schema({ path: pathField }, ['path']),
      run: async ({ path }) => {
        assertWorkspace(ws);
        checkedPath(path);
        const item = (await ws.listTrash()).find(f => f.path === path);
        if (!item) throw invalid('回收站没有这个完整路径，请先查看回收站。');
        const restored = await ws.restoreTrash(path, item);
        return JSON.stringify({ changedCount: 1, status: 'restored', paths: [restored.path] });
      }
    }
  ];
}

export async function replyToFileTrashPreview({ tools, history, userText, sessionId, emit, signal, suggestFiles = false }) {
  const reply = String(userText || '').trim();
  const tool = tools.find(t => t.name === 'prepare_file_trash' && t.finishPreview);
  if (!tool || !sessionId) return null;
  if (/^(?:请|帮我|我想|我要|把|将|彻底|永久|清空|删除|清除)[^。！？?]*回收站(?:里|中|内|的)?[^。！？?]*$/u.test(reply)
    && (/清空回收站|清除回收站|永久删|彻底删|回收站(?:里|中|内|的).*删/.test(reply))) {
    return { text: '清空回收站会永久移除文件。请在「文件空间 → 回收站」查看具体文件和当前空间可用的操作。', toolCalls: 0 };
  }
  const last = history?.at(-1);
  const previous = last?.role === 'assistant' && typeof last.content === 'string' ? last.content.trimEnd() : '';
  const menu = previous.endsWith(choose) ? pendingBySession().get(sessionId) : null;
  let paths;
  if (menu?.choices && Date.now() - menu.at <= TTL && previous.endsWith(menu.text)) {
    if (/^(?:第\s*)?\d{1,2}(?:\s*(?:[,，、和]\s*(?:第\s*)?)\d{1,2})*\s*(?:个|项|份)?[。！!]?$/u.test(reply)) {
      const indices = reply.match(/\d+/g).map(Number);
      if (indices.some(i => i < 1 || i > menu.choices.length)) return { text: menu.text, toolCalls: 0 };
      paths = indices.map(i => menu.choices[i - 1]);
    } else {
      const matches = menu.choices.filter(p => p === reply || p.split('/').pop() === reply);
      if (matches.length === 1) paths = matches;
    }
  }
  if (menu?.choices && !paths && menu.choices.some(p => p.split('/').pop() === reply)) {
    return { text: '有多个同名文件，请回复清单里的完整路径或序号。\n\n' + menu.text, toolCalls: 0 };
  }
  if (paths || wholeSpaceRemoval(reply) || vagueRemoval(reply) || suggestFiles) {
    const id = 'workspace-file-selection';
    const args = paths ? { paths } : {};
    emit({ type: 'tool_start', id, name: tool.name, args });
    const start = Date.now();
    try {
      throwControl(null, signal);
      const text = await tool.run(args, { sessionId, rawRequestText: reply });
      emit({ type: 'tool_end', id, name: tool.name, ok: true, output: text, ms: Date.now() - start });
      return { text, toolCalls: 1 };
    } catch (error) {
      throwControl(null, signal);
      emit({ type: 'tool_end', id, name: tool.name, ok: false, output: error.message, ms: Date.now() - start });
      return { text: error.message, toolCalls: 1 };
    }
  }
  if (previous.endsWith(bulkQuestion)) {
    if (bulkConfirm.test(reply) || cancel.test(reply)) return tool.finishPreview({ sessionId, previous, cancelled: cancel.test(reply), emit, signal });
    if (confirm.test(reply)) return { text: previous, toolCalls: 0 };
  }
  if ((bulkConfirm.test(reply) || /^(?:确认|确定)删除(?:这些|这批)?文件[。！!]?$/u.test(reply)) && !previous.endsWith(question)) {
    return { text: '当前对话没有已核对的待删清单，请先选择文件或说明要清空哪个文件空间。', toolCalls: 0 };
  }
  if (!confirm.test(reply) && !cancel.test(reply)) return null;
  if (!previous.endsWith(question)) return null;
  throwControl(null, signal);
  return tool.finishPreview({ sessionId, previous, cancelled: cancel.test(reply), emit, signal });
}
