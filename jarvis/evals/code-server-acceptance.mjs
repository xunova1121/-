/** 仅依据真实回执与Git差异验收，不把任务done当测试通过。 */
export function codeAcceptance(events, changed, { before, after, head, workspaceId }) {
  const runs = [];
  const starts = new Map(events.filter((event) => event.type === 'tool_start').map((event) => [event.id, event.args || {}]));
  const lastWrite = events.findLastIndex((event) => event.type === 'tool_end' && event.ok && /^code_(edit|write)$/.test(event.name));
  for (const event of events.filter((item) => item.type === 'tool_end' && item.name === 'code_run')) {
    try {
      const text = String(event.output || '');
      const value = JSON.parse(event.ok ? text : text.slice(text.indexOf('完整回执：') + 5));
      if (
        value.isolation === 'docker_offline_snapshot' &&
        /^[a-f0-9]{64}$/.test(value.sourceDigest || '') &&
        starts.get(event.id)?.workspace_id === workspaceId
      )
        runs.push({ ...value, eventOk: event.ok, eventIndex: events.indexOf(event) });
    } catch {
      /* 解析不到真实结构化结果不计验收。 */
    }
  }
  const failures = [];
  if (!/^[a-f0-9]{24}$/.test(workspaceId || '')) failures.push('缺工作副本编号');
  if (!runs.some((item) => !item.eventOk && item.command === 'test' && item.stage === 'test' && item.exitCode !== 0 && item.install?.exitCode === 0))
    failures.push('没有复现原始测试失败');
  const lastTest = runs.filter((item) => item.command === 'test').at(-1);
  if (!(lastTest?.eventOk && lastTest.ok && lastTest.exitCode === 0 && lastTest.install?.exitCode === 0 && lastTest.eventIndex > lastWrite))
    failures.push('最后一次test未真实通过');
  if (!runs.some((item) => item.command === 'lint' && item.eventOk && item.ok && item.exitCode === 0 && item.sourceDigest === lastTest?.sourceDigest))
    failures.push('没有与最终test同一份代码的成功lint');
  if (!changed.length || changed.some((item) => !/^src\//.test(item.path))) failures.push('没有业务代码修改，或改了测试/配置等范围外文件');
  if (!before || before !== after || head !== before) failures.push('远端main或本地HEAD与测试前不一致');
  return {
    state: failures.length ? 'failed' : 'passed',
    failures,
    runs: runs.map(({ command, stage, exitCode, sourceDigest, imageId, install }) => ({
      command,
      stage,
      exitCode,
      sourceDigest,
      imageId,
      installExitCode: install?.exitCode
    }))
  };
}
