import { createHash } from 'node:crypto';
import { allowedCodePath, readCodeFile } from './codeRepoFiles.mjs';
import { codeError } from './codeGit.mjs';
/** 审批摘要含未跟踪文件内容hash；状态??本身不能证明文件内容未变。 */
export async function codePublishPlan(current, execution, run) {
  const raw = (await run(['status', '--porcelain=v1', '-z', '--untracked-files=all'], current.cwd, execution, current.connection)).stdout
    .split('\0')
    .filter(Boolean);
  if (raw.length > 50) throw codeError('CODE_PUBLISH_LIMIT', '本次修改超过50项，先分批整理');
  const files = [],
    hash = createHash('sha256');
  const head = (await run(['rev-parse', 'HEAD'], current.cwd, execution, current.connection)).stdout.trim();
  hash.update(head + '\0');
  for (const row of raw) {
    const status = row.slice(0, 2),
      name = row.slice(3);
    if (!allowedCodePath(name) || /[RCU!]/.test(status)) throw codeError('CODE_PUBLISH_PATH', '含不允许的文件或未解决重命名/冲突，请先核对');
    const deleted = /D/.test(status),
      read = deleted ? null : await readCodeFile(current.cwd, name, current.connection.token, { asAsset: true });
    if (read?.redacted) throw codeError('CODE_SECRET', '修改文件含凭据，未准备推送');
    const sha256 = read?.sha256 || 'deleted';
    hash.update(name + '\0' + status + '\0' + sha256 + '\0');
    files.push({ path: name, status, sha256 });
  }
  return { head, files, digest: hash.digest('hex'), branch: 'weiyang/task-' + current.row.id, repository: current.row.repository };
}
export async function commitCodeBranch(current, input, execution, run) {
  const plan = await codePublishPlan(current, execution, run);
  const message = String(input.message || 'Update project')
    .replace(/[\x00-\x1f]/g, ' ')
    .slice(0, 180);
  if (plan.digest !== input.digest) {
    // 上次已经本地提交、但提交号没来得及记下（服务重启 / 断电）：沿用那个提交去推送，不重复提交，也不让它卡死在本地
    const done = await previousCommit(current, input, plan, message, execution, run);
    if (done) return done;
    throw codeError('CODE_APPROVAL_STALE', '代码在确认后变化，请重新核对保存清单');
  }
  if (!plan.files.length) throw codeError('CODE_NOTHING_TO_SAVE', '当前副本没有待保存修改');
  const flags = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgSign=false'];
  await run([...flags, 'add', '--', ...plan.files.map((f) => f.path)], current.cwd, execution, current.connection);
  await run(
    [...flags, '-c', 'user.name=Weiyang', '-c', 'user.email=weiyang@users.noreply.github.com', 'commit', '-m', message],
    current.cwd,
    execution,
    current.connection
  );
  const commit = (await run(['rev-parse', 'HEAD'], current.cwd, execution, current.connection)).stdout.trim();
  return { commit, branch: plan.branch, repository: plan.repository, files: plan.files.length };
}
/** 工作区已干净、HEAD 的父提交就是确认时的 HEAD、作者和说明是未央写的、改动文件和确认清单一致：才认作上次的提交 */
async function previousCommit(current, input, plan, message, execution, run) {
  if (!/^[a-f0-9]{40,64}$/.test(input.head || '') || plan.files.length || !Array.isArray(input.files)) return null;
  const git = async (args) => (await run(args, current.cwd, execution, current.connection)).stdout;
  try {
    const [parent, email, subject] = (await git(['log', '-1', '--format=%P%x00%ae%x00%s', 'HEAD'])).replace(/\n$/, '').split('\0');
    if (parent !== input.head || email !== 'weiyang@users.noreply.github.com' || subject !== message) return null;
    const changed = (await git(['diff', '--name-only', '-z', input.head, 'HEAD'])).split('\0').filter(Boolean).sort();
    const asked = input.files.map((f) => f.path).sort();
    if (changed.join('\0') !== asked.join('\0')) return null;
  } catch {
    return null;
  }
  return { commit: plan.head, branch: plan.branch, repository: plan.repository, files: input.files.length, recovered: true };
}
export async function pushCodeBranch(current, input, execution, run) {
  const head = (await run(['rev-parse', 'HEAD'], current.cwd, execution, current.connection)).stdout.trim();
  if (!/^[a-f0-9]{40,64}$/.test(input.commit || '') || head !== input.commit) throw codeError('CODE_APPROVAL_STALE', '工作分支提交已变化，请重新核对');
  const branch = 'weiyang/task-' + current.row.id;
  await run(
    ['-c', 'core.hooksPath=/dev/null', 'push', 'https://github.com/' + current.row.repository + '.git', 'HEAD:refs/heads/' + branch],
    current.cwd,
    execution,
    current.connection
  );
  return { repository: current.row.repository, branch, commit: head, pushed: true };
}
