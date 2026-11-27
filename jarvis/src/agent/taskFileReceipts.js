import { posterArtifactId } from '../../shared/posterArtifactPath.js';

export const PROCESS_FILE = /(?:^|\/)(?:文档检查|\.workflows|\.checkpoints|检查记录)\//i;

export function publicTaskResultPath(path) {
  return (
    typeof path === 'string' &&
    path.length <= 600 &&
    !/[\\\u0000-\u001f]/.test(path) &&
    !/(?:^|\/)\.\.?(?:\/|$)|^\/|^(?:上传|uploads?|skills)\//i.test(path) &&
    ((!PROCESS_FILE.test(path) && !/(?:^|\/)\./.test(path)) || Boolean(posterArtifactId(path)))
  );
}

// A result belongs to the turn that received the write, even if a later turn overwrites the same path.
export function noteTaskFile(turn, version) {
  if (!turn || !publicTaskResultPath(version?.path) || !Number.isFinite(version.mtime) || !Number.isFinite(version.size)) return;
  const versions = (turn.fileVersions ??= new Map());
  versions.delete(version.path);
  versions.set(version.path, { path: version.path, mtime: version.mtime, size: version.size });
  if (versions.size > 12) versions.delete(versions.keys().next().value);
}

export function taskFileDelivery(turn) {
  if (!turn?.fileScope) return {};
  return { fileDelivery: { scope: turn.fileScope, files: [...(turn.fileVersions?.values() || [])] } };
}
