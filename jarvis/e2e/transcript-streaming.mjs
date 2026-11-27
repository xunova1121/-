import assert from 'node:assert/strict';

// 同一份多段正文、并发工具与一批进度回执，数实际 DOM 写入，避免给慢机器设测速门槛。
export async function checkStreaming(page, progress) {
  const result = await page.evaluate(async (progress) => {
    const { Transcript } = await import('/src/ui/transcript.js');
    const root = document.getElementById('fixture');
    root.replaceChildren();
    const transcript = new Transcript(root, { progress });
    const bubble = transcript.add('agent');
    bubble.el.classList.add('streaming');
    const body = bubble.el.querySelector('.body');
    const words = '已经找到报道。';
    bubble.append(words);
    const immediate = body.textContent === words;
    const section = '\n\n### 原文摘录\n- 发布时间\n- 记者署名\n- 本文来源';
    bubble.append(section.repeat(48));
    const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
    await frame();
    const card = bubble.toolCard('web_search', { query: '报道' });
    const heading = body.querySelector('h5');
    let sameHeading = 0;
    for (let i = 0; i < 12; i++) {
      bubble.toolCard('web_fetch', { url: 'https://example.com/' + i }).done(true, '读到正文', i);
      if (heading && heading === body.querySelector('h5')) sameHeading++;
    }
    const pre = bubble.el.querySelector(progress ? '.pc-steps li pre' : '.tool-card pre');
    let writes = 0;
    const observer = new MutationObserver(records => { writes += records.length; });
    observer.observe(pre, { childList: true, characterData: true, subtree: true });
    const lines = Array.from({ length: 300 }, (_, i) => '核对来源 ' + i);
    for (const line of lines) card.progress(line);
    await frame();
    await Promise.resolve();
    writes += observer.takeRecords().length;
    observer.disconnect();
    card.progress('最后一条');
    card.done(false, '链接已经过期', 340);
    const summary = bubble.el.querySelector(progress ? '.pc-steps li small' : '.tool-card .ta').textContent;
    const completeLog = pre.textContent === [...lines, '最后一条'].map(t => '· ' + t).join('\n') + '\n\n链接已经过期';
    const interrupted = bubble.toolCard('fetch_url', {url:'https://example.com/end'});
    interrupted.progress('中断前最后一条进度');
    bubble.append('。\n\n**末段**');
    bubble.done('已打断');
    await frame();
    const tagged = transcript.add('agent');
    tagged.append('甲<emo');
    tagged.append('tion>专注</emo');
    tagged.append('tion>乙');
    await frame();
    const clean = tagged.el.querySelector('.body').textContent === '甲乙';
    tagged.append('丙');
    tagged.done();
    return {
      immediate, sameHeading, writes, completeLog, summary, clean,
      tail: bubble.el.querySelector('.body strong')?.textContent,
      saved: bubble.text === words + section.repeat(48) + '。\n\n**末段**',
      finalized: !bubble.el.classList.contains('streaming') && bubble.el.textContent.includes('中断前最后一条进度')
    };
  }, progress);
  console.log(progress ? '手机进展' : '桌面工具', result);
  assert(result.immediate, '收到了真正首段后应立即写进对话');
  assert.equal(result.sameHeading, 12, '下一工具开始时保留已经排好的正文节点');
  assert(result.writes <= 3, '一批进度只需刷新一次日志');
  assert(result.completeLog && result.finalized && result.saved, '结束、打断或帧未执行时都保留完整文本及进度');
  assert(result.clean, '跨片段的旧情绪标签保持隐藏');
  assert.equal(result.summary, '链接已经过期');
  assert.equal(result.tail, '末段');
}

export async function checkDenseReply(page) {
  const measured = await page.evaluate(async () => {
    const { Transcript } = await import('/src/ui/transcript.js');
    const fixture = document.querySelector('#fixture');
    const transcript = new Transcript(fixture, { progress: true });
    const head = Array.from({length: 18}, (_, i) => '项目' + i);
    const row = cells => '| ' + cells.join(' | ') + ' |';
    const rows = Array.from({length: 180}, (_, i) => row(head.map((_, j) => j ? String(i + j) : '第' + (i + 1) + '条')));
    rows[179] = rows[179].replace('第180条', '[第180条](https://example.org/file)');
    const markdown = [row(head), row(head.map(() => '---')), ...rows].join('\n');
    function render(safe) {
      document.documentElement.classList.toggle('safe-render', safe);
      fixture.replaceChildren();
      const bubble = transcript.add('agent');
      bubble.append(markdown);
      bubble.done();
      return bubble;
    }
    const standard = render(false).el.querySelector('.body').querySelectorAll('*').length;
    const bubble = render(true);
    const body = bubble.el.querySelector('.body');
    const initial = body.querySelectorAll('*').length;
    const controls = body.querySelector('.msg-pages');
    const next = controls.lastElementChild;
    let total = 0, max = 0;
    do {
      total += body.querySelectorAll('tr').length - 1;
      max = Math.max(max, body.querySelectorAll('*').length);
      if (next.disabled) break;
      next.click();
    } while (total <= 180);
    const link = body.querySelector('a')?.href;
    controls.firstElementChild.click();
    const back = !next.disabled && body.querySelector('th')?.textContent === '项目0';
    let copied;
    Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{writeText: async text => { copied = text; }}});
    bubble.el.querySelector('.msg-copy').click();
    await Promise.resolve();
    delete navigator.clipboard;
    const tiny = transcript.add('agent');
    tiny.append('| 标题 |\n| -- |\n| 本文 |'); tiny.done();
    const small = !!tiny.el.querySelector('td') && !tiny.el.querySelector('.msg-pages');
    const list = transcript.add('agent');
    list.append(Array.from({length: 200}, (_, i) => (i + 1) + '. 第' + (i + 1) + '项').join('\n'));
    list.done();
    list.el.querySelector('.msg-pages button:last-child').click();
    const order = list.el.querySelector('ol').start;
    document.documentElement.classList.remove('safe-render');
    return {standard, initial, max, total, link, back, small, order, completeCopy: copied?.includes('第180条') && copied.includes('第1条')};
  });
  console.log('兼容模式大表分页', measured);
  assert(measured.standard > 3000 && measured.max < 400 && measured.total === 180);
  assert(measured.completeCopy && measured.back && measured.small);
  assert.equal(measured.order, 81);
  assert.equal(measured.link, 'https://example.org/file');
}
