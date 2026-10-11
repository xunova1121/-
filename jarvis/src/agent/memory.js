/**
 * 记忆与进化。
 *
 * “自主学习”在这里的含义很具体，不是改动大模型本身的参数，而是在本机持续积累三类东西，
 * 每次对话按相关度取出来放进上下文，让后面的回答越来越贴合用户：
 *   memories  长期记忆：用户的偏好、身份、事实（模型调用 remember 工具写入，用户可查看 / 删除）
 *   lessons   经验教训：用户点 👎 并说明原因时记下，之后遇到相似问题会先读这些教训
 *   skills    技能库：完成多步任务后，模型把可复用的做法保存为技能（save_skill），下次直接照做
 * events 是进化日志，记录每一次“学到了什么”。
 */
import { collection, uid } from './store.js';
import { buildIndex } from './search.js';

const memories = collection('memories');
const lessons = collection('lessons');
const skills = collection('skills');
const events = collection('events');

async function log(kind, text) {
  await events.put({ id: uid('e'), kind, text, ts: Date.now() });
}

export async function remember(content, category = 'fact') {
  content = String(content || '').trim();
  if (!content) throw new Error('记忆内容为空');
  const all = await memories.all();
  // 去重：完全相同的内容只更新时间
  const dup = all.find((m) => m.content === content);
  if (dup) {
    dup.ts = Date.now();
    await memories.put(dup);
    return dup;
  }
  const m = { id: uid('m'), content, category, ts: Date.now(), uses: 0 };
  await memories.put(m);
  await log('memory', `记住：${content}`);
  return m;
}

export async function forget(id) {
  const m = await memories.get(id);
  await memories.delete(id);
  if (m) await log('forget', `忘记：${m.content}`);
}

export async function addLesson(content, context = '') {
  const l = { id: uid('l'), content: String(content).trim(), context: String(context).slice(0, 200), ts: Date.now() };
  await lessons.put(l);
  await log('lesson', `吸取教训：${l.content}`);
  return l;
}

export async function saveSkill({ name, description, steps }) {
  name = String(name || '').trim();
  if (!name || !steps) throw new Error('技能需要名称和步骤');
  const all = await skills.all();
  const old = all.find((s) => s.name === name);
  const s = { id: old?.id ?? uid('s'), name, description: String(description || ''), steps: String(steps), ts: Date.now(), uses: old?.uses ?? 0, version: (old?.version ?? 0) + 1 };
  await skills.put(s);
  await log('skill', old ? `技能升级：${name}（v${s.version}）` : `习得技能：${name}`);
  return s;
}

export async function noteTask(text) {
  await log('task', text);
}

async function rank(items, query, text, k) {
  if (!items.length) return [];
  const search = buildIndex(items.map((x) => ({ id: x.id, text: text(x) })));
  const hits = search(query, k);
  const byId = new Map(items.map((x) => [x.id, x]));
  return hits.map((h) => ({ ...byId.get(h.id), score: h.score }));
}

/** 为当前问题取出相关的记忆 / 教训 / 技能（另加最近的几条偏好，保证“认识用户”） */
export async function contextFor(query) {
  const [ms, ls, ss] = await Promise.all([memories.all(), lessons.all(), skills.all()]);
  const relevant = await rank(ms, query, (m) => m.content, 6);
  const recentPrefs = ms.filter((m) => m.category === 'preference' || m.category === 'profile').sort((a, b) => b.ts - a.ts).slice(0, 4);
  const mem = [...new Map([...recentPrefs, ...relevant].map((m) => [m.id, m])).values()].slice(0, 8);
  return {
    memories: mem,
    lessons: await rank(ls, query, (l) => `${l.content} ${l.context}`, 3),
    skills: await rank(ss, query, (s) => `${s.name} ${s.description}`, 3)
  };
}

export async function recall(query) {
  return rank(await memories.all(), query, (m) => m.content, 8);
}

export async function listAll() {
  const [ms, ls, ss, es] = await Promise.all([memories.all(), lessons.all(), skills.all(), events.all()]);
  const by = (a, b) => b.ts - a.ts;
  return { memories: ms.sort(by), lessons: ls.sort(by), skills: ss.sort(by), events: es.sort(by) };
}

export async function deleteItem(kind, id) {
  const c = { memories, lessons, skills }[kind];
  if (c) await c.delete(id);
}

/** 进化等级：积累越多等级越高（经验值 = 记忆×2 + 教训×3 + 技能×5 + 知识文档×2 + 完成任务×1） */
export function levelOf({ memories: m = 0, lessons: l = 0, skills: s = 0, docs = 0, tasks = 0 }) {
  const xp = m * 2 + l * 3 + s * 5 + docs * 2 + tasks;
  const level = Math.floor(Math.sqrt(xp / 5)) + 1;
  const cur = 5 * (level - 1) ** 2;
  const next = 5 * level ** 2;
  return { xp, level, progress: (xp - cur) / (next - cur), next };
}
