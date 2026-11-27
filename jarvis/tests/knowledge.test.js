import { describe, it, expect, beforeEach } from 'vitest';
import * as kb from '../src/agent/knowledge.js';

// 假的向量模型：按“概念”出向量，同义词落到同一维度
const CONCEPTS = [
  ['差旅', '出差', '报销', '报多少', '补贴'],
  ['年假', '休假', '请假', '放假'],
  ['密码', '登录', '账号'],
  ['天气', '下雨']
];
function fakeEmbedder(model = 'fake:v1') {
  const calls = [];
  return {
    model,
    calls,
    async embed(texts) {
      calls.push(texts.length);
      return texts.map((t) => CONCEPTS.map((words) => words.filter((w) => t.includes(w)).length + 0.01));
    }
  };
}

async function reset() {
  kb.configureKnowledge({});
  for (const d of await kb.listDocuments()) await kb.removeDocument(d.id);
}
beforeEach(reset);

describe('知识库检索', () => {
  it('没有向量服务时只用关键词', async () => {
    await kb.addDocument({ name: '制度.txt', text: '差旅补贴标准：一线城市每天 500 元。' });
    const hits = await kb.search('差旅补贴', 3);
    expect(hits[0].name).toBe('制度.txt');
    expect(hits[0].via).toEqual(['关键词']);
    expect(hits[0].embedding).toBeUndefined();
    expect(kb.knowledgeEngine().embeddings).toBeNull();
  });

  it('换种说法也能按意思找到（语义检索）', async () => {
    kb.configureKnowledge({ embedder: fakeEmbedder() });
    await kb.addDocument({ name: '差旅制度.txt', text: '差旅补贴标准：一线城市每天 500 元，其他城市 300 元。' });
    await kb.addDocument({ name: '休假制度.txt', text: '员工每年享有 10 天带薪年假。' });
    const hits = await kb.search('出差能报多少钱', 2);
    expect(hits[0].name).toBe('差旅制度.txt');
    expect(hits[0].via).toContain('语义');
    expect(hits[0].embedding).toBeUndefined();
  });

  it('关键词和语义都命中的排在前面（RRF 融合）', async () => {
    kb.configureKnowledge({ embedder: fakeEmbedder() });
    await kb.addDocument({ name: 'A.txt', text: '年假怎么请：在系统里提交请假单。' });
    await kb.addDocument({ name: 'B.txt', text: '放假安排见通知。' });
    const hits = await kb.search('年假', 2, 0.1);
    expect(hits[0].name).toBe('A.txt');
    expect(hits[0].via).toEqual(['关键词', '语义']);
  });

  it('旧文档可以补算向量', async () => {
    await kb.addDocument({ name: '账号.txt', text: '忘记密码时联系管理员重置。' });
    const e = fakeEmbedder();
    kb.configureKnowledge({ embedder: e });
    expect(await kb.pendingEmbeddings()).toBe(1);
    const progress = [];
    expect(await kb.reindex({ onProgress: (d, t) => progress.push([d, t]) })).toBe(1);
    expect(progress).toEqual([[1, 1]]);
    expect(await kb.pendingEmbeddings()).toBe(0);
    const hits = await kb.search('登录不上怎么办', 2);
    expect(hits[0].name).toBe('账号.txt');
    // 换了模型要重新算
    kb.configureKnowledge({ embedder: fakeEmbedder('fake:v2') });
    expect(await kb.pendingEmbeddings()).toBe(1);
  });

  it('向量服务出错时导入不失败，退回关键词', async () => {
    kb.configureKnowledge({ embedder: { model: 'bad:x', embed: async () => { throw new Error('401'); } } });
    const d = await kb.addDocument({ name: 'x.txt', text: '天气预报：明天下雨。' });
    expect(d.chunks).toBe(1);
    const hits = await kb.search('天气预报', 2);
    expect(hits[0].via).toEqual(['关键词']);
  });
});
