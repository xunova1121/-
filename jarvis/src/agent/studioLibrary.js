import { collection } from './store.js';
import * as workspace from './workspace.js';
import { cleanStudio, cleanBrand, STUDIO_EXTENSIONS, STUDIO_LIMITS } from '../core/studioData.js';
import { digest } from './documentXml.js';
import { inspectEditableDocument, applyStructuredEdits } from './structuredDocumentEdit.js';
import { editOffice } from './officeEdit.js';
import { replaceSlidePicture } from './studioPictureEdit.js';
import { userStorageSuffix } from '../core/userStorage.js';

const KEY = 'creative-studio.v1';
const REVISIONS = 'creative-studio-revisions.v1';
const queues = new WeakMap();
const counts = new WeakMap();
const fail = (message, code = 'STUDIO_INPUT', status = 400) => Object.assign(new Error(message), { code, status, kind: 'input' });
function serial(store, work) {
  const key = store.scopeKey || store;
  if ((counts.get(key) || 0) >= 16) return Promise.reject(fail('作品操作繁忙，请稍后再试', 'STUDIO_BUSY', 429));
  counts.set(key, (counts.get(key) || 0) + 1);
  const next = (queues.get(key) || Promise.resolve())
    .catch(() => {})
    .then(() => {
      const locks = !store.scopeKey && globalThis.navigator?.locks;
      return locks?.request ? locks.request('weiyang-studio' + userStorageSuffix(), work) : work();
    });
  queues.set(key, next);
  next
    .finally(() => {
      counts.set(key, counts.get(key) - 1);
      if (queues.get(key) === next) queues.delete(key);
    })
    .catch(() => {});
  return next;
}
const id = () => crypto.randomUUID();
const safeTitle = (value) =>
  String(value || '作品')
    .replace(/[\\/\u0000-\u001f]/g, '')
    .trim()
    .slice(0, 100) || '作品';
/** 私人作品只引用现有工作区；短偏好100收藏/12最近/60模板，版本索引最多200项。 */
export function createStudioLibrary({ storage = collection('kv'), files = workspace } = {}) {
  const bind = () => storage.bind?.() || storage;
  const prefs = async (store) => cleanStudio((await store.get(KEY))?.value);
  const read = async (path) => {
    if (typeof path !== 'string' || path.length > 500 || !STUDIO_EXTENSIONS.test(path)) throw fail('请选择支持的文档或图片');
    const blob = await files.readBlob(path);
    if (!blob.size || blob.size > STUDIO_LIMITS.fileBytes) throw fail('作品须为非空文件，且不超过20MB');
    return blob;
  };
  async function record(store, source, target) {
    const rows = (await store.get(REVISIONS))?.items || [];
    const root = rows.find((x) => x.path === source)?.root || source;
    const item = { id: id(), path: target, parent: source, root, at: Date.now() };
    await store.put({ id: REVISIONS, items: [item, ...rows].slice(0, STUDIO_LIMITS.works) });
    return item;
  }
  async function save(store, source, blob, { folder = '作品版本', title } = {}) {
    if (!blob.size || blob.size > STUDIO_LIMITS.fileBytes) throw fail('修改后的作品超过20MB，请缩小图片后重试；原件未修改');
    const extension = files.ext(source);
    const fileTitle = safeTitle(
      title ||
        source
          .split('/')
          .pop()
          .replace(/\.[^.]+$/, '')
    );
    const result = await files.write(`${folder}/${fileTitle}-${id()}.${extension}`, blob);
    await record(store, source, result.path);
    return result;
  }
  return {
    preferences: () => prefs(bind()),
    change(value) {
      const store = bind();
      return serial(store, async () => {
        const state = await prefs(store);
        if (value.action === 'favorite') {
          if (!/^[a-z][a-z0-9-]{0,63}$/.test(value.id || '')) throw fail('智能体编号无效');
          if (state.favorites.includes(value.id)) state.favorites = state.favorites.filter((x) => x !== value.id);
          else {
            if (state.favorites.length >= STUDIO_LIMITS.favorites) throw fail('最多收藏100个智能体');
            state.favorites.push(value.id);
          }
        } else if (value.action === 'recent') state.recent = [value.id, ...state.recent.filter((x) => x !== value.id)];
        else if (value.action === 'brand') state.brand = cleanBrand(value.brand);
        else if (value.action === 'remove-template') state.templates = state.templates.filter((x) => x.path !== value.path);
        else throw fail('不支持的偏好操作');
        const next = cleanStudio(state);
        await store.put({ id: KEY, value: next });
        return next;
      });
    },
    async list() {
      return (await files.list())
        .filter((x) => STUDIO_EXTENSIONS.test(x.path) && !/(^|\/)(\.|文档检查\/|检查记录\/)/.test(x.path))
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, STUDIO_LIMITS.works);
    },
    async versions(path) {
      const items = (await bind().get(REVISIONS))?.items || [];
      const root = items.find((x) => x.path === path)?.root || path;
      return [{ path: root, original: true }, ...items.filter((x) => x.root === root).sort((a, b) => b.at - a.at)];
    },
    async inspect(path) {
      const blob = await read(path),
        kind = files.ext(path);
      if (['docx', 'pptx', 'xlsx', 'pdf'].includes(kind)) return inspectEditableDocument(blob, kind, { limit: 100 });
      return { format: kind, sha256: await digest(blob), objects: [], total: 0 };
    },
    copy({ path, title, template = false }) {
      const store = bind();
      return serial(store, async () => {
        const state = await prefs(store);
        if (template && state.templates.length >= STUDIO_LIMITS.templates) throw fail('最多保留60份个人模板');
        const result = await save(store, path, await read(path), { folder: template ? '个人模板' : '作品版本', title });
        if (template) {
          state.templates.unshift({ path: result.path, title: safeTitle(title || path.split('/').pop()), at: Date.now() });
          await store.put({ id: KEY, value: cleanStudio(state) });
        }
        return result;
      });
    },
    edit({ path, sha256, replacements = [], slides = [], operations = [], picture }) {
      const store = bind();
      return serial(store, async () => {
        const blob = await read(path),
          kind = files.ext(path);
        if (!sha256 || (await digest(blob)) !== sha256) throw fail('文件已变化，请重新打开后修改', 'DOCUMENT_CONFLICT', 409);
        if (!Array.isArray(replacements) || !Array.isArray(operations) || !Array.isArray(slides)) throw fail('修改格式无效');
        if ([replacements.length > 0, operations.length > 0, Boolean(picture)].filter(Boolean).length !== 1)
          throw fail('每次请选择文字、格式或图片中的一项修改');
        if (replacements.length && !['docx', 'pptx'].includes(kind)) throw fail('直接文字替换仅支持Word和PPT');
        if (picture && kind !== 'pptx') throw fail('直接换图仅支持可编辑PPT');
        const result = picture
          ? await replaceSlidePicture(blob, picture.target, await read(picture.path))
          : replacements.length
            ? await editOffice(blob, kind, { replacements, slides, expectedCount: 1 })
            : await applyStructuredEdits(blob, kind, operations, { expectedDigest: sha256 });
        if ((await digest(await read(path))) !== sha256) throw fail('修改期间原文件已变化，请重读', 'DOCUMENT_CONFLICT', 409);
        const saved = await save(store, path, result.blob);
        return { ...saved, changes: result.changes || result.replaced, preview: '请打开新版本预览；此操作没有调用模型或执行Office渲染' };
      });
    }
  };
}
