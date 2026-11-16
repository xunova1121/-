/** 只记同会话当前作品索引和验收约束；图片/正文仍在原工作区，不把助手回答当源稿。 */
import { collection, scopedState } from './store.js';
import * as ws from './workspace.js';
import { wantsIllustratedPoster } from './posterContent.js';
import { throwControl } from '../core/networkRequest.js';

const kv = collection('kv'), sessions = collection('sessions');
const identity = scopedState('kv', () => ({}));
const key = sessionId => 'design-task:' + String(sessionId).slice(0, 200);
const workspace = () => ws.mode() + ':' + ws.folderName();
export function designFollowup(text = '') {
  const value = String(text).split('\n【')[0].trim();
  if (value.length > 1000 || /先不|不做|别做|不要|不用|只(?:解释|分析|讨论)|为什么|什么原因|怎么|是否|能不能|计划|建议/.test(value)) return false;
  return /^(?:继续(?:做海报|修改|做|吧)?|接着做|就这样做|按这个做|补(?:个|一个)?Demo)[。！! ]*$/i.test(value) || /(?:只|仅)?(?:改|换|调整|加|删除|移除|放大|缩小|保留).{0,18}(?:标题|文字|文案|字号|颜色|配色|底图|人物|卡槽|风格|版式|结构|布局)|(?:补|加|做).{0,6}(?:同稿|同设计).{0,4}Demo/i.test(value);
}
export async function rememberDesignTask(sessionId, receipt, request, { signal } = {}) {
  if (!sessionId || !receipt.delivery?.primaryPath || !/\.(?:design|canvas|poster)\.json$/i.test(receipt.designPath || '')) return;
  const storage = kv.bind(), sessionStore = sessions.bind(), area = workspace();
  const session = await sessionStore.get(sessionId);
  if (!session || session.evaluationId) return;
  throwControl(null, signal);
  const previous = await storage.get(key(sessionId));
  const raw = String(request || '').split('\n【')[0].slice(0, 1800);
  const inherited = designFollowup(raw) && previous?.workspace === area;
  await storage.put({ id: key(sessionId), sessionId, workspace: area, title: String(receipt.title || receipt.delivery.title || '').slice(0, 160),
    sourcePath: receipt.designPath, primaryPath: receipt.delivery.primaryPath, deliveryId: receipt.delivery.id,
    historyStep: Number(receipt.delivery.primaryPath.match(/\/attempt-(\d+)\//)?.[1]) || 1,
    historyPrefix: receipt.delivery.historyPrefix,
    sourceAliases: (receipt.delivery.sourceAliases || []).slice(0, 3),
    request: inherited ? previous.request : raw,
    illustrated: wantsIllustratedPoster(request) || inherited && previous.illustrated === true,
    quality: receipt.delivery.quality, updatedAt: Date.now() });
}
export async function recallDesignTask(sessionId, text, { history = [], signal } = {}) {
  if (!sessionId || !designFollowup(text)) return null;
  const lastUser = [...history].reverse().find(m => m.role === 'user');
  if (lastUser && !designFollowup(lastUser.content) && !/海报|\.design\.json|\.canvas\.json|同稿.*Demo/i.test(String(lastUser.content))) return null;
  const captured = workspace(), storage = kv.bind(), owner = identity();
  const record = await storage.get(key(sessionId));
  if (!record || record.workspace !== captured || !/\.(?:design|canvas|poster)\.json$/i.test(record.sourcePath || '')) return null;
  if (!/^[a-f0-9-]{36}$/.test(record.deliveryId || '') || record.historyPrefix !== `.workflows/posters/${record.deliveryId}/` ||
    typeof record.primaryPath !== 'string' || !record.primaryPath.startsWith(record.historyPrefix) || !record.primaryPath.endsWith('.png')) return null;
  throwControl(null, signal);
  if (!await ws.exists(record.sourcePath) || !await ws.exists(record.primaryPath)) return null;
  throwControl(null, signal);
  if (workspace() !== captured || identity() !== owner) return null;
  return { ...record, request: String(record.request || '').slice(0, 1800), title: String(record.title || '').slice(0, 160),
    historyStep: Number(record.primaryPath.match(/\/attempt-(\d{1,9})\//)?.[1]) || 1,
    sourceAliases: (Array.isArray(record.sourceAliases) ? record.sourceAliases : []).filter(p => typeof p === 'string' && p.length <= 400).slice(0, 3) };
}
export async function designTaskRequirement(text, options) {
  if (options.isolated) return text;
  const task = await recallDesignTask(options.sessionId, text, options);
  if (!task) return text;
  return text + '\n【当前作品索引，仅用于承接这次修改】' + JSON.stringify({ title: task.title, source_path: task.sourcePath,
    originalRequest: task.request, ...(task.illustrated && { requirement: '图文并茂，继承主题关联与成品复核' }), quality: task.quality })
    + '\n修改用此真实源稿；先读原稿按ID改字，保留未要求改变的文案/素材；原稿存在不代表本次修改或验收完成。';
}
