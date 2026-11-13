import { repositoryReceipt } from '../src/agent/codeRepositoryReview.js';

/** 任务结束后只读取该任务事件；最多8MB，保留受控回执而不保存源码/终端输出。 */
export async function readCodeEvidence(base, token, taskId, fetchImpl = fetch, signal) {
  if (!/^[\w-]{1,80}$/.test(taskId || '')) return { complete: false, runs: [], edits: [], remoteWrite: false };
  const origin = new URL(base);
  if (
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    !['http:', 'https:'].includes(origin.protocol) ||
    (origin.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))
  )
    throw new Error('代码证据地址无效');
  const url = new URL(origin.pathname.replace(/\/$/, '') + `/api/tasks/${taskId}/events?after=0`, origin.origin);
  const timeout = AbortSignal.timeout(15000);
  const activeSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetchImpl(url, { redirect: 'error', signal: activeSignal, headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok || !response.body) throw new Error('代码证据读取失败');
  const reader = response.body.getReader(),
    chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      bytes += r.value.length;
      if (bytes > 8_000_000) throw new Error('代码证据超过上限');
      chunks.push(r.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  activeSignal.throwIfAborted();
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  const starts = new Map(),
    runs = [],
    edits = [];
  let complete = false,
    remoteWrite = false,
    firstSequence = null;
  for (const frame of new TextDecoder().decode(body).split(/\r?\n\r?\n/)) {
    const line = frame.split(/\r?\n/).find((row) => row.startsWith('data: '));
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line.slice(6));
    } catch {
      throw new Error('代码事件格式无效');
    }
    firstSequence ??= event.seq;
    if (event.type === 'task_state' && ['done', 'error', 'stopped'].includes(event.status)) complete = true;
    if (event.type === 'tool_start' && /^code_|^repo_/.test(event.name || '') && starts.size < 200) starts.set(event.id, event);
    if (event.type !== 'tool_end') continue;
    const start = starts.get(event.id);
    starts.delete(event.id);
    if (!start || start.name !== event.name) continue;
    if (/^code_(?:push|merge|publish)/.test(event.name) && event.ok) remoteWrite = true;
    const id = start.args?.workspace_id;
    if (!/^[a-f0-9]{24}$/.test(id || '')) continue;
    if (/^code_(?:edit|write)$/.test(event.name) && event.ok && edits.length < 32)
      edits.push({ workspaceId: id, path: String(start.args?.path || '').slice(0, 400), sequence: event.seq });
    if (event.name !== 'code_run' || runs.length >= 32) continue;
    const command = start.args?.command;
    if (!['lint', 'test'].includes(command)) continue;
    const receipt = repositoryReceipt('code_run', { workspace_id: id, command }, event.ok, event.output);
    let result = null;
    try {
      const text = String(event.output || '');
      const index = text.indexOf('完整回执：');
      result = JSON.parse(index >= 0 ? text.slice(index + 5) : text);
    } catch {
      /* 截断或不完整JSON不能伪装成运行通过。 */
    }
    const genuine =
      result?.command === command &&
      result?.stage === command &&
      result?.install?.exitCode === 0 &&
      result?.isolation === 'docker_offline_snapshot' &&
      result?.hostWorktreeWritable === false &&
      /^[a-f0-9]{64}$/.test(result.sourceDigest || '');
    const counts = {};
    if (genuine && command === 'test')
      for (const match of String(result.stdout || '').matchAll(/(?:^|\n)#\s*(tests|pass|fail|skipped)\s+(\d+)/g)) {
        const value = Number(match[2]);
        if (value <= 1000000) counts[match[1]] = value;
      }
    runs.push({
      workspaceId: id,
      command,
      sequence: event.seq,
      ok: Boolean(event.ok && genuine && result.exitCode === 0),
      exitCode: genuine && Number.isInteger(result.exitCode) ? result.exitCode : null,
      sourceDigest: genuine ? result.sourceDigest : null,
      testCounts: Object.keys(counts).length ? counts : null,
      redTest: Boolean(receipt.diagnosticTest),
      greenTest: Boolean(receipt.testVerified)
    });
  }
  return { complete: complete && firstSequence === 1, runs, edits, remoteWrite };
}

export function codeResumeProblems(turns) {
  const [first, second] = turns.map((turn) => turn.codeEvidence);
  if (!first?.complete || !second?.complete) return ['代码工具事件证据缺失，续做和测试结果待核验'];
  const ids = new Set([...first.runs, ...second.runs, ...first.edits, ...second.edits].map((row) => row.workspaceId));
  const problems = [];
  if (ids.size !== 1) problems.push('前后两轮没有只沿用同一个工作副本');
  const red = first.runs.find((row) => row.command === 'test' && row.redTest);
  const green = first.runs.find((row) => row.command === 'test' && row.greenTest && red && row.sequence > red.sequence);
  if (!red || !green || red.sourceDigest === green.sourceDigest || !first.edits.some((row) => row.sequence > red.sequence && row.sequence < green.sequence))
    problems.push('缺少先复现失败、修改业务文件、再测试通过的真实证据');
  for (const command of ['lint', 'test'])
    if (!second.runs.some((row) => row.command === command && row.ok && (command !== 'test' || row.greenTest))) problems.push('追问没有真实重新通过' + command);
  if (green && second.runs.some((row) => row.ok && row.sourceDigest !== green.sourceDigest)) problems.push('追问的源码指纹与修复通过时不一致');
  if (!second.runs.some((row) => row.command === 'test' && row.ok && row.testCounts?.tests > 0 && row.testCounts?.fail === 0))
    problems.push('追问缺少真实测试总数与失败数');
  if (
    [...first.edits, ...second.edits].some((row) =>
      /(^|\/)(?:tests?|__tests__)(\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$|(^|\/)(?:package(?:-lock)?\.json|[^/]*lock[^/]*$)/i.test(row.path)
    )
  )
    problems.push('修改了测试或包/锁文件，不符合本题边界');
  if (second.edits.length) problems.push('追问要求只读和重跑检查，但又修改了文件');
  if (first.remoteWrite || second.remoteWrite) problems.push('本题发生了推送或合并，不符合隔离要求');
  return problems;
}
