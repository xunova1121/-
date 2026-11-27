import { openOfficePackage, orderedSlidePaths } from './officePackage.js';
import { parseXml, serialize, descendants, packageBlob } from './documentXml.js';
import { slideObjects } from './slideStructuredEdit.js';
const RELATIONSHIP_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** 只替换选中图片的嵌入关系，分配独立媒体部件；共享旧媒体的其他图片不受影响。 */
export async function replaceSlidePicture(blob, targetId, picture) {
  const match = /^slide([1-9]\d*):shape\d+$/.exec(targetId || '');
  if (!match || picture.size > 10e6) throw new Error('请选择PPT里的图片，并上传10MB以内PNG或JPEG');
  const head = new Uint8Array(await picture.slice(0, 8).arrayBuffer());
  const png = head.length === 8 && [...head].join(',') === '137,80,78,71,13,10,26,10';
  const jpg = head[0] === 255 && head[1] === 216 && head[2] === 255;
  if (!png && !jpg) throw new Error('替换图片须为真实PNG或JPEG文件');
  const zip = await openOfficePackage(blob),
    paths = await orderedSlidePaths(zip);
  const slidePath = paths[Number(match[1]) - 1];
  if (!slidePath) throw new Error('PPT页码不存在');
  const slide = parseXml(await zip.file(slidePath).async('string'));
  const shape = slideObjects(slide, Number(match[1])).find((x) => x.id === targetId && x.kind === 'pic');
  const blip = shape && descendants(shape.node, 'a', 'blip')[0];
  if (!blip?.getAttributeNS(RELATIONSHIP_NS, 'embed')) throw new Error('所选对象不是可替换的嵌入图片');
  const relPath = slidePath.replace(/([^/]+)$/, '_rels/$1.rels');
  const relationships = parseXml(await zip.file(relPath).async('string'));
  const suffix = png ? 'png' : 'jpg';
  const unique = crypto.randomUUID().replace(/-/g, '');
  const media = `studio-${unique}.${suffix}`,
    relId = 'rIdStudio' + unique;
  const relation = relationships.createElementNS('http://schemas.openxmlformats.org/package/2006/relationships', 'Relationship');
  relation.setAttribute('Id', relId);
  relation.setAttribute('Type', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image');
  relation.setAttribute('Target', '../media/' + media);
  relationships.documentElement.appendChild(relation);
  blip.setAttributeNS(RELATIONSHIP_NS, 'r:embed', relId);
  const types = parseXml(await zip.file('[Content_Types].xml').async('string'));
  if (!Array.from(types.getElementsByTagName('Default')).some((n) => n.getAttribute('Extension') === suffix)) {
    const entry = types.createElementNS(types.documentElement.namespaceURI, 'Default');
    entry.setAttribute('Extension', suffix);
    entry.setAttribute('ContentType', png ? 'image/png' : 'image/jpeg');
    types.documentElement.appendChild(entry);
  }
  zip.file(slidePath, serialize(slide));
  zip.file(relPath, serialize(relationships));
  zip.file('[Content_Types].xml', serialize(types));
  zip.file('ppt/media/' + media, await picture.arrayBuffer());
  return { blob: await packageBlob(zip, blob.type), changes: [{ action: 'replace_picture', target: targetId, matched: 1 }] };
}
