import { isRetrievalStop } from '../../shared/retrievalStop.js';
import { toolLabel } from '../ui/transcript.js';

const MAX_ENTRIES = 48;
const MAX_SESSIONS = 20;

function filename(path) {
  if (typeof path !== 'string' || path.length > 512 || /[:][/]{2}|[?#@=\r\n]/.test(path)) return '';
  const name = path.split(/[\\/]/).at(-1) || '';
  if (!/^[\p{L}\p{N}][\p{L}\p{N} ._()（）-]{0,55}\.[a-z0-9]{1,8}$/iu.test(name)) return '';
  if (/secret|password|token|credential|api[._-]?key|sk[-_]|私钥|密钥|密码|[a-z0-9]{24,}/i.test(name)) return '';
  return name;
}

function toolAction(name) {
  if (typeof name !== 'string' || !/^[a-z][a-z_0-9]{1,60}$/.test(name) || name.startsWith('mcp_')) return { pose: 'run', title: '调用工具' };
  const label = toolLabel(name);
  const title = typeof label === 'string' && label !== name ? label : '调用工具';
  const pose = /^(?:write|edit|create|generate|make|process|render|export|save|update|code_(?:edit|write)|computer_write)/.test(name)
    ? 'edit'
    : /^(?:read|inspect|review|check|plan|reconcile|code_read|computer_(?:read|look))/.test(name)
      ? 'think'
      : 'run';
  return { pose, title };
}

const terminal = {
  done: { pose: 'cheer', title: '已完成本轮回复' },
  error: { pose: 'stomp', title: '本轮执行遇到问题' },
  stopped: { pose: 'stop', title: '本轮已停止' },
  waiting: { pose: 'stop', title: '等待服务器更新进度' }
};

function historyEntries(session) {
  const message = session?.messages?.at(-1);
  if (!message || !['assistant', 'agent'].includes(message.role) || message.proactive || session.taskId) return [];
  const entries = [];
  const add = (pose, title, status, file, detail = '会话记录') =>
    entries.push({ id: 'history-' + entries.length, pose, title, status, detail, ...(file && { file }) });
  const failures = new Set(
    (Array.isArray(message.failures) ? message.failures : [])
      .slice(-12)
      .map((f) => f?.tool)
      .filter(Boolean)
  );
  for (const name of new Set((Array.isArray(message.tools) ? message.tools : []).slice(-20))) {
    if (failures.has(name)) continue;
    const { pose, title } = toolAction(name);
    add(pose, title, 'done', '', '会话记录 · 已调用');
  }
  for (const name of failures) add('stomp', toolAction(name).title + '遇到问题', 'error');
  for (const file of new Set((Array.isArray(message.files) ? message.files : []).slice(-12).map(filename).filter(Boolean)))
    add('edit', '工作区文件', 'done', file);
  const end = String(message.content || '').slice(-160);
  if (/（已打断(?:，还没完成；以上内容已保留)?）\s*$/.test(end)) add('stop', '本轮已停止', 'stopped');
  else if (/（本轮回答未完成[：；][^）]*）\s*$/.test(end)) add('stop', '回复中断', 'stopped');
  else if (message.draftOf) add('stop', '已保存部分进度', 'waiting');
  else add('idle', failures.size ? '已回复，记录中有失败步骤' : '已保存回复', 'done');
  return entries;
}

// 每一轮绑定创建时的会话与存储后端。时间线仅存于内存，重新打开时使用会话已有的回执。
export function createStudioActivity({ scope = () => null } = {}) {
  const sessions = new Map();
  const owners = new WeakMap();
  const sessionScopes = new WeakMap();
  const sessionRuns = new WeakMap();
  const listeners = new Set();
  let nextId = 0;
  const changed = () => listeners.forEach((fn) => fn());
  const add = (state, entry) => {
    const item = { id: 'action-' + ++nextId, detail: '', status: 'running', ...entry };
    state.entries.push(item);
    if (state.entries.length > MAX_ENTRIES) {
      const first = state.entries.shift();
      for (const [id, row] of state.calls) if (row === first) state.calls.delete(id);
    }
    return item;
  };
  const phase = (state, pose, title, status = 'running') => {
    const last = state.entries.at(-1);
    if (last?.title === title && last.pose === pose && last.status === status) return false;
    if (state.phase?.status === 'running') state.phase.status = 'done';
    state.phase = add(state, { pose, title, status });
    return true;
  };

  function begin(turn, { resume = false } = {}) {
    const id = turn.session?.id;
    if (!id) return;
    sessions.delete(id);
    const state = { active: true, entries: [], calls: new Map(), scope: scope(), seq: -1 };
    sessions.set(id, state);
    sessionScopes.set(turn.session, state.scope);
    sessionRuns.set(turn.session, state);
    if (sessions.size > MAX_SESSIONS) {
      const old = [...sessions].find(([, s]) => !s.active);
      sessions.delete(old?.[0] || sessions.keys().next().value);
    }
    owners.set(turn, state);
    phase(state, resume ? 'run' : 'think', resume ? '接上服务器任务' : '正在思考');
    changed();
  }

  function record(turn, e) {
    const state = owners.get(turn);
    if (!state?.active || typeof e?.type !== 'string' || state !== sessions.get(turn.session.id)) return;
    if (Number.isSafeInteger(e.seq)) {
      if (e.seq <= state.seq) return;
      state.seq = e.seq;
    }
    if (e.type === 'file') {
      const file = filename(e.path);
      if (!file || state.entries.some((row) => row.title === '工作区文件' && row.file === file)) return;
      add(state, { pose: 'edit', title: '工作区文件', status: 'done', file });
    } else if (e.type === 'tool_start' || e.type === 'tool_end') {
      if (e.name === 'update_plan') return;
      const prev = state.calls.get(e.id);
      if (isRetrievalStop(e)) {
        if (!prev) return;
        state.calls.delete(e.id);
        state.entries.splice(state.entries.indexOf(prev), 1);
      } else {
        if (typeof e.id !== 'string' || (prev && (e.type === 'tool_start' || prev.status !== 'running'))) return;
        if (state.phase?.status === 'running') state.phase.status = 'done';
        const action = toolAction(e.name);
        const file = filename(e.args?.path || e.args?.output_path || e.args?.filename);
        const row = prev || add(state, { ...action, ...(file && { file }) });
        state.calls.set(e.id, row);
        if (e.type === 'tool_end') {
          row.status = e.ok ? 'done' : 'error';
          state.lastOperationFailed = !e.ok;
          if (!e.ok) Object.assign(row, { pose: 'stomp', title: row.title + '遇到问题' });
          // 并行步骤可能倒序完成，把最新获得回执的动作排在最后。
          state.entries.splice(state.entries.indexOf(row), 1);
          state.entries.push(row);
        }
      }
    } else {
      if (e.type === 'team_review') state.lastOperationFailed = !e.pass;
      if (e.type === 'team_step' && ['fail', 'done'].includes(e.status)) state.lastOperationFailed = e.status === 'fail';
      let action;
      if (e.type === 'text' && e.delta) action = ['edit', '正在写回复'];
      else if (e.type === 'seeing') action = ['think', '正在看图'];
      else if (e.type === 'state' && e.value === 'processing') action = ['think', '正在思考'];
      else if (e.type === 'plan' || e.type === 'team_plan') action = ['edit', '正在安排步骤'];
      else if (e.type === 'interjection_accepted') action = ['edit', '已收到补充要求'];
      else if (e.type === 'retry') action = ['repair', '正在重试'];
      else if (e.type === 'fallback') action = e.capability ? ['run', '正在切换模型'] : ['repair', '正在切换备用模型'];
      else if (e.type === 'team_step' && e.status === 'redo') action = ['repair', '正在返工'];
      else if (e.type === 'team_step' && e.status === 'fail') action = ['stomp', '协作步骤遇到问题', 'error'];
      else if (e.type === 'team_step' && e.status === 'running') action = ['run', '正在执行协作步骤'];
      else if (e.type === 'team_review') action = e.pass ? ['think', '复核通过', 'done'] : ['stomp', '复核发现问题', 'error'];
      else if (e.type === 'server_tool')
        action = /read|fetch/.test(e.name) ? ['think', '正在阅读网页'] : /search/.test(e.name) ? ['run', '正在联网检索'] : ['run', '正在调用模型工具'];
      else if (e.type === 'tool_progress' && e.id === 'queue') action = ['think', '等待服务器执行', 'waiting'];
      else if (e.type === 'server_connection') action = e.state === 'connected' ? ['run', '已恢复连接', 'done'] : ['repair', '正在重连'];
      if (!action || !phase(state, ...action)) return;
    }
    changed();
  }

  function finish(turn, status) {
    const state = owners.get(turn);
    if (!state?.active || !Object.hasOwn(terminal, status)) return;
    state.active = false;
    if (state !== sessions.get(turn.session.id)) return;
    for (const row of state.entries) {
      if (row.status === 'running') row.status = row === state.phase && status === 'done' ? 'done' : status === 'waiting' ? 'waiting' : 'stopped';
    }
    const recorded = new Set(state.entries.filter((row) => row.title === '工作区文件').map((row) => row.file));
    for (const file of new Set(
      Array.from(turn.files || [])
        .slice(-12)
        .map(filename)
        .filter(Boolean)
    )) {
      if (!recorded.has(file)) add(state, { pose: 'edit', title: '工作区文件', status: 'done', file });
    }
    const outcome =
      status === 'done' && state.lastOperationFailed ? { pose: 'stomp', title: '已回复，仍有步骤未完成', status: 'error' } : { ...terminal[status], status };
    add(state, outcome);
    // 在新一轮由其他端完成时，旧的内存记录应让位给新回复。
    state.finishedAt = Date.now();
    state.taskId = turn.remoteId || null;
    changed();
  }

  function snapshot(session) {
    const sessionId = session?.id || '';
    const owner = scope();
    if (!session || (sessionScopes.has(session) && sessionScopes.get(session) !== owner)) return { sessionId, active: false, entries: [] };
    sessionScopes.set(session, owner);
    const state = sessions.get(sessionId);
    const sameTask = state?.taskId && state.taskId === session?.taskCheckpoint?.taskId;
    const resolved = sameTask && state.entries.at(-1)?.status === 'waiting' && ['done', 'stopped', 'error'].includes(session.taskCheckpoint.status);
    const sameObservedTask = state?.taskId && state.taskId === session.taskId;
    const useLive =
      state &&
      state.scope === owner &&
      !resolved &&
      (state.active ||
        sameObservedTask ||
        (!session.taskId && (sessionRuns.get(session) === state || sameTask || !(session.messages?.at(-1)?.ts > state.finishedAt))));
    return { sessionId, active: Boolean(useLive && state.active), entries: useLive ? state.entries.map((e) => ({ ...e })) : historyEntries(session) };
  }

  return {
    begin,
    record,
    finish,
    snapshot,
    changed,
    forget(session) {
      sessions.delete(session?.id);
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    }
  };
}
