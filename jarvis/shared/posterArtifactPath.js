/** 只有统一交付器公开通知的主PNG可出现在聊天；其它过程文件仍隐藏。 */
export function posterArtifactId(path) {
  return typeof path === 'string' ? path.match(/^\.workflows\/posters\/([a-f0-9-]{36})\/attempt-\d+\/[^/]+(?<!\.phone)\.png$/i)?.[1] || '' : '';
}
