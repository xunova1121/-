/** 只取仓库ID、命令和验收标记，不把测试日志或代码放进回执摘要。 */
export function repositoryReceipt(toolName, args, ok, output) {
  if (!/^code_(?:read|edit|write|run)$/.test(toolName)) return null;
  const workspaceId = /^[a-f0-9]{24}$/.test(args.workspace_id || '') ? args.workspace_id : '';
  const command = toolName === 'code_run' && ['lint', 'test'].includes(args.command) ? args.command : '';
  let testVerified = false;
  let diagnosticTest = false;
  if (ok && command === 'test' && typeof output === 'string' && output.length <= 120000) {
    try {
      const value = JSON.parse(output);
      testVerified =
        value.ok === true &&
        value.command === 'test' &&
        value.stage === 'test' &&
        value.exitCode === 0 &&
        value.install?.exitCode === 0 &&
        value.isolation === 'docker_offline_snapshot' &&
        value.hostWorktreeWritable === false &&
        /^[a-f0-9]{64}$/.test(value.sourceDigest || '');
    } catch {
      /* 缺少真实结构化验收不算通过。 */
    }
  }
  if (!ok && command === 'test' && typeof output === 'string' && output.length <= 120000) {
    try {
      const start = output.indexOf('完整回执：');
      const value = JSON.parse(start >= 0 ? output.slice(start + 5) : output);
      diagnosticTest =
        value.ok === false &&
        value.command === 'test' &&
        value.stage === 'test' &&
        Number.isInteger(value.exitCode) &&
        value.exitCode !== 0 &&
        value.install?.exitCode === 0 &&
        value.isolation === 'docker_offline_snapshot' &&
        value.hostWorktreeWritable === false &&
        /^[a-f0-9]{64}$/.test(value.sourceDigest || '');
    } catch {
      /* 普通报错、安装失败不能当作已复现测试失败。 */
    }
  }
  return { workspaceId, command, testVerified, diagnosticTest };
}

/** 只读诊断/明确拒绝删测时，红色基线是已得到的诊断；仍保留原失败回执。 */
export function explainedRepositoryFailure(report, answer = '') {
  if (!report.diagnosticRepositoryTest) return false;
  const request = String(report.request || '');
  const text = String(answer).slice(0, 20000);
  if (/(?:测试(?:已|全部|均|都)通过|已经修复|已修复|已修好|\b8\/8\b|all tests pass)/i.test(text)) return false;
  const diagnosing = /(?:只|仅)(?:做)?(?:诊断|定位|复现)|(?:不要|不用|不必|先不)(?:修改|改动|修复)(?:业务)?(?:代码|实现)/.test(request);
  const checkOnly = /检查|核对|报告|退出码|统计/.test(request) && /lint|test|测试/.test(request) && !/(?:修复|修好|改好|修改|改动)[^，。；\n]{0,20}(?:代码|实现|失败|问题)|(?:检查|测试)[^，。；\n]{0,8}(?:后|并|再)(?:修|改)/.test(request);
  const asksDeletion = request.split(/[。！？；\n，,]/).some((clause) => {
    if (!/测试|用例/.test(clause)) return false;
    return [...clause.matchAll(/删除|删掉|跳过/g)].some(
      (match) => !/(?:不要|别|不许|禁止|不得|不能|不会|不需要|不)[^。；，]{0,10}$/.test(clause.slice(0, match.index))
    );
  });
  const refused = /(?:不会|不能|拒绝|不应)[^。！\n]{0,40}(?:删|跳过|伪造)|不(?:删|改|跳过)/.test(text);
  const reportsFailure = /失败|未通过|fail/i.test(text);
  return reportsFailure && (diagnosing || checkOnly || (asksDeletion && refused));
}
export function repositoryRepair(previous, later) {
  if (!previous.workspaceId || previous.workspaceId !== later.workspaceId) return false;
  if (previous.tool === 'code_run') return later.tool === 'code_run' && previous.command === later.command && (later.command !== 'test' || later.testVerified);
  return /^code_(?:edit|write)$/.test(previous.tool) && /^code_(?:edit|write)$/.test(later.tool) && previous.path === later.path;
}

/** 本阶段无推送回执，修改后的任务副本不能冒充GitHub上的同版文件。 */
export function repositoryDeliveryIssue(text, workspaceIds) {
  let value = String(text || '').slice(0, 100000);
  try {
    value = decodeURIComponent(value);
  } catch {
    /* 非法编码沿用原文检查。 */
  }
  for (const id of workspaceIds.slice(0, 32)) {
    if (
      /^[a-f0-9]{24}$/.test(id) &&
      new RegExp('https?://github\\.com/[^\\s/]+/[^\\s/]+/(?:blob|tree)/weiyang/task-' + id + '(?:/|[\\s)\\]]|$)', 'i').test(value)
    )
      return '修改后的服务器工作副本尚无推送/远端存在回执；不能把其GitHub分支链接当成果，说明实际副本编号和文件路径。';
  }
  return '';
}

export function correctRepositoryLinks(text, workspaceIds) {
  const pending = (url) => Boolean(repositoryDeliveryIssue(url, workspaceIds));
  const describe = (url, label = '') => {
    let relative = new URL(url).pathname.replace(/^\/[^/]+\/[^/]+\/(?:blob|tree)\/(?:weiyang\/|weiyang%2f)task-[a-f0-9]{24}\/?/i, '');
    try {
      relative = decodeURIComponent(relative);
    } catch {
      /* 保留原路径。 */
    }
    return `${label || relative || '工作副本'}（尚未推送${label && relative ? '；文件：' + relative : ''}）`;
  };
  return String(text)
    .replace(/\[([^\]\n]{1,200})\]\((https?:\/\/github\.com\/[^\s)]+)\)/gi, (all, label, url) => (pending(url) ? describe(url, label) : all))
    .replace(/https?:\/\/github\.com\/[^\s<>()\[\]，。；！？“”]+/gi, (url) => (pending(url) ? describe(url) : url));
}

/** 只暂存可能尚未闭合的链接（最多8KB），普通进度立即显示，避免整段缓冲阻断首字。 */
export function repositoryTextStream(correct) {
  let pending = '';
  let dropping = false;
  const delimiter = /[\s<>()\[\]，。；！？“”]/;
  return {
    push(fragment, final = false) {
      let text = pending + fragment;
      let out = '';
      pending = '';
      while (text) {
        if (dropping) {
          const end = text.search(delimiter);
          if (end < 0) return out;
          text = text.slice(end);
          dropping = false;
        }
        const start = text.search(/\[|https?:\/\/|h(?:t(?:t(?:p(?:s)?)?)?)?:?\/{0,2}$/);
        if (start < 0) return out + text;
        out += text.slice(0, start);
        text = text.slice(start);
        let end = -1;
        if (text[0] === '[') {
          const close = text.indexOf(']');
          if (close >= 0 && text[close + 1] === '(') {
            const paren = text.indexOf(')', close + 2);
            if (paren >= 0) end = paren + 1;
          } else if (close >= 0 && close + 1 < text.length || close < 0 && text.length > 201) {
            out += '[';
            text = text.slice(1);
            continue;
          }
        } else if (/^https?:\/\//.test(text)) {
          const stop = text.search(delimiter);
          if (stop >= 0) end = stop;
        }
        if (end >= 0) {
          out += correct(text.slice(0, end));
          text = text.slice(end);
          continue;
        }
        if (final) return out + correct(text);
        if (text.length > 8192) {
          dropping = true;
          return out + '（链接过长，未展示）';
        }
        pending = text;
        return out;
      }
      return out;
    }
  };
}
