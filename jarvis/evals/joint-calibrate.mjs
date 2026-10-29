/**
 * 校准：用户抽查打分，和自动评审员对比；分差大的题拿出来看，是标准写得不清还是评审打歪了。
 *
 *   node evals/joint-calibrate.mjs sample 报告.json [--n=10]     抽题，生成“校准打分表.md”和空白“校准打分.json”
 *   node evals/joint-calibrate.mjs compare 报告.json 校准打分.json  对比，结果写回报告的 calibration
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DIMENSIONS } from './joint-rubric.mjs';

const KEYS = Object.keys(DIMENSIONS);

/** 抽题：每组至少一题，优先不稳定、评审格式出错、刚好卡在及格线附近的；同一份报告抽出来的题固定 */
export function sampleRuns(report, n = 10) {
  const candidates = report.results.flatMap((r) => r.runs.filter((x) => x.judgement && !x.judgement.error).map((x) => ({ r, x })));
  const weight = ({ r, x }) => (r.stability?.stable === false ? 0 : 1) * 10 + Math.abs(x.judgement.total - 13);
  const sorted = [...candidates].sort((a, b) => weight(a) - weight(b) || a.r.id.localeCompare(b.r.id) || a.x.attempt - b.x.attempt);
  const picked = [];
  for (const group of [...new Set(sorted.map((c) => c.r.group))]) {
    const first = sorted.find((c) => c.r.group === group);
    if (first && picked.length < n) picked.push(first);
  }
  for (const c of sorted) if (picked.length < n && !picked.includes(c) && !picked.some((p) => p.r.id === c.r.id)) picked.push(c);
  return picked.map(({ r, x }) => ({ id: r.id, attempt: x.attempt }));
}

/** 给用户看的打分表（不含评审员的分，免得先入为主） */
export function sheet(report, picks) {
  const dims = KEYS.map((k) => `- **${DIMENSIONS[k].label}**：5分=${DIMENSIONS[k].anchors[5]}；3分=${DIMENSIONS[k].anchors[3]}；1分=${DIMENSIONS[k].anchors[1]}`).join('\n');
  const body = picks.map(({ id, attempt }, i) => {
    const r = report.results.find((x) => x.id === id);
    const run = r.runs.find((x) => x.attempt === attempt);
    const turns = run.turns.map((t, j) => `**第${j + 1}轮问**：${t.prompt}\n\n**未央答**：\n\n${String(t.answer || '（无回答）').slice(0, 3000)}`).join('\n\n');
    const facts = run.fileFacts ? `\n\n**程序读回的文件**：${run.fileFacts.map((f) => (f ? `${f.path}：正文${f.body ?? '?'}磅、标题${f.title ?? '?'}磅、横线${f.rules ?? '?'}、页数${f.pages ?? '?'}` : '无文件')).join('；')}` : '';
    return `## ${i + 1}. ${id}（第${attempt}次，${r.group}）\n\n**检查点**：${r.rubric.join('；')}\n\n${turns}${facts}\n\n打分：答到点子上 __ / 事实对 __ / 表达自然 __ / 交付物能用 __ ；通过？__ ；说做到没做到？__`;
  });
  return `# 30 题联合复测 · 校准打分表\n\n每题按 4 项各打 1～5 分（可以打 2、4），再判通过与否。不用写理由，觉得哪里不对可以写一句。\n\n${dims}\n\n${body.join('\n\n---\n\n')}\n`;
}

/** 对比：各维度平均差、通过与否一致率、分差 ≥2 的题 */
export function compare(report, human) {
  const rows = [];
  for (const h of human) {
    const run = report.results.find((r) => r.id === h.id)?.runs.find((x) => x.attempt === h.attempt);
    const j = run?.judgement;
    if (!j || j.error || !h.scores || KEYS.some((k) => !Number.isInteger(h.scores[k]))) continue;
    const diff = Object.fromEntries(KEYS.map((k) => [k, j.scores[k] - h.scores[k]]));
    rows.push({ id: h.id, attempt: h.attempt, judge: j.scores, human: h.scores, diff, passAgree: typeof h.pass === 'boolean' ? h.pass === j.pass : null, overclaimAgree: typeof h.overclaim === 'boolean' ? h.overclaim === j.overclaim : null, note: h.note || '' });
  }
  const avg = (list) => (list.length ? Math.round((list.reduce((a, b) => a + b, 0) / list.length) * 100) / 100 : null);
  const passVotes = rows.filter((r) => r.passAgree !== null);
  return {
    compared: rows.length,
    // 正数 = 评审员打得比你高
    meanDiff: Object.fromEntries(KEYS.map((k) => [DIMENSIONS[k].label, avg(rows.map((r) => r.diff[k]))])),
    meanAbsDiff: Object.fromEntries(KEYS.map((k) => [DIMENSIONS[k].label, avg(rows.map((r) => Math.abs(r.diff[k])))])),
    passAgreement: passVotes.length ? passVotes.filter((r) => r.passAgree).length / passVotes.length : null,
    bigGaps: rows.filter((r) => KEYS.some((k) => Math.abs(r.diff[k]) >= 2)).map((r) => ({ id: r.id, attempt: r.attempt, dims: KEYS.filter((k) => Math.abs(r.diff[k]) >= 2).map((k) => `${DIMENSIONS[k].label}（评审${r.judge[k]}、你${r.human[k]}）`), note: r.note })),
    // 平均差在 1 分以内、通过一致率 ≥80%：以后主要靠自动评审，你只看有争议的题
    trusted: rows.length >= 5 && KEYS.every((k) => Math.abs(avg(rows.map((r) => r.diff[k])) ?? 9) <= 1) && passVotes.length > 0 && passVotes.filter((r) => r.passAgree).length / passVotes.length >= 0.8,
    rows
  };
}

export async function main(args = process.argv.slice(2)) {
  const [mode, file, humanFile] = args.filter((a) => !a.startsWith('--'));
  const report = JSON.parse(await fs.readFile(file, 'utf8'));
  if (mode === 'sample') {
    const picks = sampleRuns(report, Number(args.find((a) => a.startsWith('--n='))?.slice(4)) || 10);
    const dir = path.dirname(file);
    await fs.writeFile(path.join(dir, '校准打分表.md'), sheet(report, picks), { mode: 0o600 });
    await fs.writeFile(path.join(dir, '校准打分.json'), JSON.stringify(picks.map((p) => ({ ...p, scores: Object.fromEntries(KEYS.map((k) => [k, null])), pass: null, overclaim: null, note: '' })), null, 2), { mode: 0o600 });
    console.log(`抽了${picks.length}题：${path.join(dir, '校准打分表.md')}`);
    return;
  }
  if (mode === 'compare') {
    report.calibration = { at: new Date().toISOString(), ...compare(report, JSON.parse(await fs.readFile(humanFile, 'utf8'))) };
    await fs.writeFile(file, JSON.stringify(report, null, 2), { mode: 0o600 });
    const c = report.calibration;
    console.log(`对比${c.compared}题；通过一致率${c.passAgreement === null ? '?' : Math.round(c.passAgreement * 100) + '%'}；分差≥2的${c.bigGaps.length}题；${c.trusted ? '评审员可信，以后主要看自动评分' : '还要修评分标准或换评审模型'}`);
    return;
  }
  throw new Error('用法：sample 报告.json [--n=10] | compare 报告.json 校准打分.json');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
