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
  if (plan.digest !== input.digest) throw codeError('CODE_APPROVAL_STALE', '代码在确认后变化，请重新核对保存清单');
  if (!plan.files.length) throw codeError('CODE_NOTHING_TO_SAVE', '当前副本没有待保存修改');
  const message = String(input.message || 'Update project')
    .replace(/[\x00-\x1f]/g, ' ')
    .slice(0, 180);
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
