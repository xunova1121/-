/** 识别成功只证明收到结果，不证明文字及行对应正确；回执最多12条、每条12行，不留原图和整段正文。 */
export async function imageFingerprint(file) {
  if (!globalThis.crypto?.subtle) return null;
  let bytes;
  if (file instanceof Blob) bytes = new Uint8Array(await file.arrayBuffer());
  else if (file?.data) {
    const encoded = String(file.data).replace(/^data:[^,]*,/, '');
    if (encoded.length > 14_000_000) return null;
    try { bytes = Uint8Array.from(atob(encoded), (letter) => letter.charCodeAt(0)); } catch { return null; }
  }
  if (!bytes || bytes.length > 10_000_000) return null;
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** 只从明确的一行表格提取对应；散落的队名和数字不能靠位置猜成同一场。 */
export function scoreRows(text) {
  const rows = [];
  let columns = null;
  for (const line of String(text || '').slice(0, 24_000).split('\n')) {
    if (!line.trim().startsWith('|')) { columns = null; continue; }
    const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.replace(/\*|`/g, '').trim());
    const scoreIndex = cells.findIndex((cell) => /^(?:当前)?比分$/.test(cell));
    if (scoreIndex >= 0) { columns = { score: scoreIndex, match: cells.findIndex((cell) => /对阵|比赛/.test(cell)), home: cells.findIndex((cell) => /主队/.test(cell)), away: cells.findIndex((cell) => /客队/.test(cell)) }; continue; }
    if (!columns || !/^\d{1,2}\s*[-–—:：]\s*\d{1,2}$/.test(cells[columns.score] || '')) continue;
    const match = columns.match >= 0 ? cells[columns.match] : [cells[columns.home], cells[columns.away]].filter(Boolean).join(' vs ');
    if (!match || match.length > 160) continue;
    rows.push({ match, score: cells[columns.score].replace(/\s/g, '').replace(/[–—:：]/, '-') });
    if (rows.length === 12) break;
  }
  return rows;
}

export const VISUAL_RECEIPT_PREFIX = '【图像识别回执】';
export function visualReceiptText(receipt) {
  return VISUAL_RECEIPT_PREFIX + JSON.stringify(receipt);
}

export function readVisualReceipt(output) {
  const line = String(output || '').split('\n', 1)[0];
  if (!line.startsWith(VISUAL_RECEIPT_PREFIX) || line.length > 5000) return null;
  try { return JSON.parse(line.slice(VISUAL_RECEIPT_PREFIX.length)); } catch { return null; }
}

export function createVisualEvidence(initiallyPresent = false) {
  let present = initiallyPresent;
  const receipts = [];
  const note = (item) => {
    present = true;
    receipts.push({ kind: item.kind === 'ocr' ? 'ocr' : 'vision', ok: Boolean(item.ok), imageHash: /^[a-f0-9]{64}$/.test(item.imageHash || '') ? item.imageHash : null, model: String(item.model || '').slice(0, 100), rows: (Array.isArray(item.rows) ? item.rows : []).slice(0, 12).map((row) => ({ match: String(row.match || '').slice(0, 160), score: String(row.score || '').slice(0, 8) })) });
    if (receipts.length > 12) receipts.shift();
  };
  const issue = (answer) => {
    const text = String(answer);
    // 明确说未调用、未确认属于如实报告；提到工具名称本身不算伪造执行。
    const claims = text.split(/[。！!；;\n]/).filter((line) => !/没有|未能|未调用|没调用|无法确认|不能确认|未核实|尚未|不代表/.test(line));
    const claimsOcr = claims.some((line) => /OCR|read_image_text|识字工具|文字识别工具|识图工具|图片识字/.test(line) && /(?:用|调用|识别|核对|确认|结果|写着|显示)/.test(line));
    const latestOcr = receipts.filter((receipt) => receipt.kind === 'ocr').at(-1);
    if (claimsOcr && !latestOcr?.ok) return '没有本轮OCR成功回执，不能声称已调用识别工具并确认；原图看不清时如实说明';
    // 候选OCR行与答复冲突时要求重新核图，不能擅自把任一来源升级为真值。
    const compact = (value) => String(value).toLowerCase().replace(/vs/g, '').replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
    if (latestOcr?.ok && !/识别不一致|存在冲突|结果冲突|看不清|不能确认|无法确认|未核实/.test(text)) {
      for (const row of latestOcr.rows) {
        const teams = row.match.split(/\s*(?:vs|对阵|—|–)\s*/i).filter(Boolean);
        if (teams.length !== 2) continue;
        for (const line of text.split('\n')) {
          const candidate = compact(line);
          const scores = [...line.matchAll(/\d{1,2}\s*[-–—:：]\s*\d{1,2}/g)];
          if (scores.length !== 1 || !teams.every(team => candidate.includes(compact(team)))) continue;
          const actual = scores[0][0].replace(/\s/g, '').replace(/[–—:：]/, '-');
          if (actual !== row.score) return '答复的比赛与比分对应和本轮OCR表格行冲突；须重新核对原图，不可只改口或盲从OCR';
        }
      }
    }
    if (present && claims.some((line) => /(?:OCR|识别|识图).{0,20}(?:必然正确|绝对准确|百分之百)/.test(line))) return 'OCR成功不等于内容核实，不能承诺识别必然准确';
    return '';
  };
  return { note, issue, active: () => present, snapshot: () => receipts.map(({ rows, ...metadata }) => ({ ...metadata, rowCount: rows.length })) };
}
