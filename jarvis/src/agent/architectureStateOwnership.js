// 无工作区/工具依赖：目录模式的内部写入与智能体修改保护共用同一所有权边界。
const managedDirectories = new Set(['架构任务', '架构底稿', '架构输入', '架构诊断', '架构回复', '架构审查回复', '架构内容', '架构候选', '架构证据']);
const managedJsonName = /(?:^|\/)(?:交付清单|[^/]+\.(?:architecture|review|diagram|exports))\.json$/i;
export const MAX_ARCHITECTURE_METADATA = 2000000; // 与既有设计稿读取上限一致，不读取无界JSON。

/** 仅用于保护检查；实际工作区仍用自己的normalize，不能借此放宽合法路径。 */
export function architecturePathParts(path) {
  if (typeof path !== 'string') return [];
  let value = path.normalize('NFC');
  for (let i = 0; i < 2 && /%[0-9a-f]{2}/i.test(value); i++) {
    try {
      const next = decodeURIComponent(value);
      if (next === value) break;
      value = next;
    } catch { break; }
  }
  const parts = [];
  for (const segment of value.replace(/\\/g, '/').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (parts.length && parts.at(-1) !== '..') parts.pop();
      else parts.push(segment);
      continue;
    }
    // Win32目录别名也作为同一路径保护，但不据此授予可信内部写权限。
    parts.push(segment.replace(/[ .]+$/, ''));
  }
  return parts;
}

export function isArchitectureManagedPath(path) {
  const parts = architecturePathParts(path);
  return parts.some((part, index) => part === '文档检查' && (index === parts.length - 1 || managedDirectories.has(parts[index + 1])));
}

/** 内部覆盖仅限根目录的真实私有文件；不能把父目录、编码别名或用户子目录当私有文件。 */
export function isArchitecturePrivateFilePath(path) {
  const parts = String(path).split('/');
  return parts.length >= 3 && parts[0] === '文档检查' && managedDirectories.has(parts[1]) && parts.every(part => part && part !== '.' && part !== '..' && !/[ .]$/.test(part));
}

export const isArchitectureMetadataPath = path => managedJsonName.test(path);

export function ownsArchitectureRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const digest = data => typeof data === 'string' && /^(?:sha256|checksum):/.test(data);
  return (typeof value.architecturePath === 'string' && digest(value.planHash)) ||
    (typeof value.architecture?.planPath === 'string' && digest(value.architecture.planHash)) ||
    (Array.isArray(value.entities) && Array.isArray(value.relations) && Array.isArray(value.materialHashes)) ||
    (digest(value.planHash) && typeof value.structure === 'string' && typeof value.semantic === 'string');
}

/** 内部清单所有权和密码学核验分开；实际版本/摘要仍由loadArchitecture及包清单校验器检查。 */
export function ownsArchitectureInternalRecord(value) {
  return ownsArchitectureRecord(value) || Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    typeof value.architecturePath === 'string' && value.architecturePath.trim() && value.architecturePath.length <= 400 &&
    typeof value.planHash === 'string' && value.planHash.trim() && value.planHash.length <= 100);
}

/** 图形导出回执同样要防伪造；它本身不授予内部架构覆盖权限。 */
export function ownsManagedDiagramMetadata(value) {
  return ownsArchitectureRecord(value) || Boolean(value && typeof value === 'object' &&
    typeof value.designHash === 'string' && /^(?:sha256|checksum):/.test(value.designHash) &&
    Array.isArray(value.artifacts) && typeof value.sourcePath === 'string');
}

export async function architectureJsonValue(data) {
  if (data === undefined || data === null) return null;
  const tooLarge = () => Object.assign(new Error('待核对的架构候选JSON超过2MB'), { code: 'ARCHITECTURE_STATE_SIZE', kind: 'input' });
  if (data instanceof Blob) {
    if (data.size > MAX_ARCHITECTURE_METADATA) throw tooLarge();
    data = await data.text();
  } else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
    if (data.byteLength > MAX_ARCHITECTURE_METADATA) throw tooLarge();
    data = new TextDecoder().decode(data);
  }
  if (typeof data !== 'string') return data;
  if (data.length > MAX_ARCHITECTURE_METADATA) throw tooLarge();
  try { return JSON.parse(data); } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return null;
  }
}
