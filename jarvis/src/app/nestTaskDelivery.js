import { posterArtifactAttempt, posterArtifactId } from '../../shared/posterArtifactPath.js';
import { publicTaskResultPath } from '../agent/taskFileReceipts.js';

export function lastTaskReceipt(session, scope, fileScope) {
  const messages = session?.messages;
  const answer = messages?.at(-1);
  if (
    !session?.id ||
    session.taskId ||
    !['assistant', 'agent'].includes(answer?.role) ||
    answer.draftOf ||
    answer.proactive ||
    !(answer.files?.length || answer.fileDelivery?.files?.length)
  )
    return null;
  if (/（(?:已打断[^）]*|本轮回答未完成[：；][^）]*)）\s*$/.test(String(answer.content || '').slice(-200))) return null;
  const delivery = answer.fileDelivery;
  if (delivery && delivery.scope !== fileScope) return null;
  // An older message does not identify the physical directory it was written to.
  if (!delivery && fileScope.startsWith('local:folder:')) return null;
  let user;
  for (let i = messages.length - 2; i >= 0; i--) {
    if (messages[i].role === 'user') {
      user = messages[i];
      break;
    }
  }
  if (!user) return null;
  const uploads = new Set((Array.isArray(user.files) ? user.files : []).map((f) => (typeof f === 'string' ? f : f?.path)));
  const deliveredPaths = delivery ? (Array.isArray(delivery.files) ? delivery.files.map((f) => f?.path) : []) : answer.files;
  const paths = [
    ...new Set((Array.isArray(deliveredPaths) ? deliveredPaths : []).slice(-12).filter((path) => publicTaskResultPath(path) && !uploads.has(path)))
  ];
  if (!paths.length) return null;
  return { sessionId: session.id, scope, answer, fileScope, paths, delivery, start: user.ts, end: answer.ts };
}

export function verifiedTaskFiles(receipt, files) {
  if (!receipt) return [];
  const entries = new Map(files.map((f) => [f.path, f]));
  const versions = new Map((Array.isArray(receipt.delivery?.files) ? receipt.delivery.files : []).filter((v) => v?.path).map((v) => [v.path, v]));
  const posters = new Map();
  const matched = receipt.paths.filter((path) => {
    const file = entries.get(path);
    if (!file || file.inTrash || !(file.size > 0) || !Number.isFinite(file.mtime)) return false;
    const version = versions.get(path);
    if (receipt.delivery) return version?.mtime === file.mtime && version.size === file.size;
    return Number.isFinite(receipt.start) && Number.isFinite(receipt.end) && file.mtime >= receipt.start && file.mtime <= receipt.end;
  });
  for (const path of matched) {
    const id = posterArtifactId(path);
    if (id && posterArtifactAttempt(path) > (posters.get(id) || 0)) posters.set(id, posterArtifactAttempt(path));
  }
  return matched.filter((p) => !posterArtifactId(p) || posters.get(posterArtifactId(p)) === posterArtifactAttempt(p)).map((path) => entries.get(path));
}

export function sameTaskReceipt(a, b) {
  return a === b || Boolean(a && b && a.scope === b.scope && a.fileScope === b.fileScope && a.sessionId === b.sessionId && a.answer === b.answer);
}
