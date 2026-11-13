import { it, expect } from 'vitest';
import { createMessageQueue } from '../src/core/messageQueue.js';

it('排队逐条FIFO出队，互不合并；移除和暂停不会改动其它问题', () => {
  const queue = createMessageQueue();
  const add = text => queue.add({ scope: 'local', sessionId: 'one', text });
  const first = add('第一件事'); const removed = add('取消的事'); add('第三件事');
  expect(queue.remove('local', 'one', removed).text).toBe('取消的事');
  queue.pause('local', 'one');
  expect(queue.take('local', 'one')).toBeNull();
  queue.pause('local', 'one', false);
  expect(queue.take('local', 'one')).toMatchObject({ id: first, text: '第一件事', echo: true });
  expect(queue.take('local', 'one').text).toBe('第三件事');
  expect(queue.take('local', 'one')).toBeNull();
});

it('不同登录客户端、不同会话完全隔离；切换或取消不能取走别人的问题', () => {
  const queue = createMessageQueue(); const owner = {}; const member = {};
  const id = queue.add({ scope: owner, sessionId: 'same-id', text: '主人问题' });
  queue.add({ scope: member, sessionId: 'same-id', text: '成员问题' });
  expect(queue.remove(member, 'same-id', id)).toBeNull();
  expect(queue.list(owner, 'other-session')).toEqual([]);
  queue.pause(owner, 'same-id');
  expect(queue.take(member, 'same-id').text).toBe('成员问题');
  expect(queue.take(owner, 'same-id')).toBeNull();
});

it('有界队列只存附件路径；拒绝超长问题和超量附件，不偷偷截断用户要求', () => {
  const queue = createMessageQueue(); const target = { scope: 'local', sessionId: 'one' };
  const files = [{ path: '上传/原图.png', image: { data: '大块原图数据', thumb: '缩略图数据' } }];
  queue.add({ ...target, text: '带图问题', files });
  expect(JSON.stringify(queue.list('local', 'one'))).not.toMatch(/大块原图数据|缩略图数据/);
  files[0].path = '之后的改动.png';
  expect(queue.list('local', 'one')[0].files).toEqual([{ path: '上传/原图.png', image: true }]);
  expect(() => queue.add({ ...target, text: 'x'.repeat(8001) })).toThrow('8000');
  expect(() => queue.add({ ...target, text: '附件', files: Array(13).fill({ path: 'a' }) })).toThrow('12');
  for (let n = 1; n < 10; n++) queue.add({ ...target, text: `问题${n}` });
  expect(() => queue.add({ ...target, text: '第十一条' })).toThrow('10');
  expect(queue.list('local', 'one')).toHaveLength(10);
});
