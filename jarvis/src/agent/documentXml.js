import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { documentError } from './documentPlan.js';
export const NS = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  x: 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
};
export function parseXml(text) {
  if (text.length > 8e6 || /<!DOCTYPE|<!ENTITY/i.test(text)) throw documentError('XML过大或含外部实体声明', 'DOCUMENT_PACKAGE');
  return new DOMParser({
    onError: (level, message) => {
      if (level !== 'warning') throw documentError('文档XML损坏：' + message.slice(0, 100), 'DOCUMENT_PACKAGE');
    }
  }).parseFromString(text, 'application/xml');
}
export const serialize = (node) => new XMLSerializer().serializeToString(node);
export const children = (node, local) => Array.from(node.childNodes || []).filter((n) => n.nodeType === 1 && (!local || n.localName === local));
export const descendants = (node, prefix, local) => Array.from(node.getElementsByTagNameNS(NS[prefix], local));
export const attr = (node, key, prefix = '') => (prefix ? node?.getAttributeNS(NS[prefix], key) : node?.getAttribute(key));
export const setAttr = (node, key, value, prefix = '') =>
  prefix ? node.setAttributeNS(NS[prefix], `${prefix}:${key}`, String(value)) : node.setAttribute(key, String(value));
export function element(parent, prefix, local, first = false) {
  let node = children(parent, local)[0];
  if (!node) {
    node = parent.ownerDocument.createElementNS(NS[prefix], `${prefix}:${local}`);
    const order = prefix === 'w' && parent.namespaceURI === NS.w && WORD_PROPERTY_ORDER[parent.localName];
    const index = order ? order.indexOf(local) : -1;
    const next = index >= 0 ? children(parent).find((child) => order.indexOf(child.localName) > index) : null;
    if (first) parent.insertBefore(node, parent.firstChild);
    else if (next) parent.insertBefore(node, next);
    else parent.appendChild(node);
  }
  return node;
}
// Word属性是有序序列：新属性不能追加到sectPr等终结属性之后。
const WORD_PROPERTY_ORDER = {
  pPr: [
    'pStyle',
    'keepNext',
    'keepLines',
    'pageBreakBefore',
    'framePr',
    'widowControl',
    'numPr',
    'suppressLineNumbers',
    'pBdr',
    'shd',
    'tabs',
    'suppressAutoHyphens',
    'kinsoku',
    'wordWrap',
    'overflowPunct',
    'topLinePunct',
    'autoSpaceDE',
    'autoSpaceDN',
    'bidi',
    'adjustRightInd',
    'snapToGrid',
    'spacing',
    'ind',
    'contextualSpacing',
    'mirrorIndents',
    'suppressOverlap',
    'jc',
    'textDirection',
    'textAlignment',
    'textboxTightWrap',
    'outlineLvl',
    'divId',
    'cnfStyle',
    'rPr',
    'sectPr',
    'pPrChange'
  ],
  rPr: [
    'rStyle',
    'rFonts',
    'b',
    'bCs',
    'i',
    'iCs',
    'caps',
    'smallCaps',
    'strike',
    'dstrike',
    'outline',
    'shadow',
    'emboss',
    'imprint',
    'noProof',
    'snapToGrid',
    'vanish',
    'webHidden',
    'color',
    'spacing',
    'w',
    'kern',
    'position',
    'sz',
    'szCs',
    'highlight',
    'u',
    'effect',
    'bdr',
    'shd',
    'fitText',
    'vertAlign',
    'rtl',
    'cs',
    'em',
    'lang',
    'eastAsianLayout',
    'specVanish',
    'oMath',
    'rPrChange'
  ]
};
export const wordText = (node) =>
  descendants(node, 'w', 't')
    .map((n) => n.textContent)
    .join('');
export const ancestor = (node, local) => {
  for (let p = node.parentNode; p; p = p.parentNode) if (p.localName === local) return p;
  return null;
};
export function number(value, min, max, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw documentError(`${label}须为${min}至${max}`, 'DOCUMENT_INPUT');
  return value;
}
export async function digest(blob) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())), (b) => b.toString(16).padStart(2, '0')).join('');
}
export function sameText(before, after) {
  if (before !== after) throw documentError('排版操作改变了原内容，本批未保存', 'DOCUMENT_PRESERVATION');
}
export async function packageBlob(zip, type) {
  return new Blob([await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })], { type });
}
