import { describe, it, expect } from 'vitest';
import { createFormDirector, formForTool, formForText, IDLE_FORMS } from '../src/core/formDirector.js';
import { FORMS, buildForm, EYE_FRACTION } from '../src/render/formations.js';

function setup(seq = [0.1]) {
  let t = 10000;
  let i = 0;
  const forms = [];
  const d = createFormDirector({ setForm: (f) => { forms.push(f); return true; } }, { now: () => t, rand: () => seq[i++ % seq.length] });
  return { d, forms, advance: (ms) => { t += ms; d.tick(); } };
}

describe('造型', () => {
  it('每个造型都是同样多的有效点；光核前面的粒子是眼睛', () => {
    for (const name of Object.keys(FORMS)) {
      const a = buildForm(name, 2000);
      expect(a).toHaveLength(6000);
      expect(a.every(Number.isFinite)).toBe(true);
    }
    const core = buildForm('core', 2000);
    const eyeN = Math.floor(2000 * EYE_FRACTION);
    for (let i = 0; i < eyeN; i++) expect(core[i * 3 + 2]).toBeGreaterThan(20); // 在球面正前方
  });
});

describe('造型导演', () => {
  it('工具和语义决定造型', () => {
    const r = () => 0;
    expect(formForTool('web_search', r)).toBe('globe');
    expect(formForTool('deep_research', r)).toBe('galaxy');
    expect(formForTool('write_file', r)).toBe('lattice');
    expect(formForTool('create_document', r)).toBe('pages');
    expect(formForTool('search_conversations', r)).toBe('constellation');
    expect(formForTool('computer_click', r)).toBe('eye');
    expect(formForTool('schedule_task', r)).toBe('clock');
    expect(formForTool('mcp_x__y', r)).toBe('lattice');
    expect(formForTool('something_else', r)).toBe('helix');
    expect(formForText('帮我写一个网页', r)).toBe('lattice');
    expect(formForText('调研一下新能源车', r)).toBe('galaxy');
    expect(formForText('你好', r)).toBeNull();
  });

  it('一轮对话：思考时按语义变形 → 工具 → 回答时回到光核 → 空闲', () => {
    const { d, forms, advance } = setup([0]);
    d.onUserText('帮我写一份周报');
    d.setState('processing');
    expect(forms.at(-1)).toBe('pages');
    advance(2000);
    d.onToolStart('web_search');
    expect(forms.at(-1)).toBe('globe');
    advance(2000);
    d.setState('speaking');
    expect(forms.at(-1)).toBe('core');
    d.setState('idle');
    expect(d.form).toBe('core');
  });

  it('每个造型至少停留 1.6 秒：太快的变化被推迟而不是丢掉', () => {
    const { d, forms, advance } = setup([0]);
    d.setState('processing'); // helix
    d.onToolStart('write_file'); // 太快：推迟
    expect(forms).toEqual(['helix']);
    advance(1700);
    expect(forms).toEqual(['helix', 'lattice']);
  });

  it('出错时竖起尖刺，过后回到光核', () => {
    const { d, forms, advance } = setup([0]);
    d.setState('error');
    expect(forms.at(-1)).toBe('spike');
    d.setState('idle');
    advance(3000);
    advance(100);
    expect(d.form).toBe('core');
  });

  it('空闲一段时间后随机漫游；用户一动就回到光核', () => {
    const { d, forms, advance } = setup([0.5]);
    advance(70000);
    expect(IDLE_FORMS).toContain(forms.at(-1));
    expect(forms.at(-1)).not.toBe('core');
    advance(2000);
    d.poke();
    expect(d.form).toBe('core');
  });

  it('语音聆听时变成聆听环', () => {
    const { d, forms } = setup([0]);
    d.setState('voice');
    expect(forms.at(-1)).toBe('rings');
  });
});
