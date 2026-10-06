import { test } from 'node:test';
import assert from 'node:assert';
import { SequenceSnapshot, ImageLoader } from '../../js/lightbox-core.js';

const page = (items, nextCursor, sortVersion = 'sv1') => ({ items, nextCursor, sortVersion });

test('灯箱序列: 快照冻结 + 乱序/重叠分页去重', async () => {
  const pages = [
    page([{ id: 'a' }, { id: 'b' }], 'c1'),
    page([{ id: 'b' }, { id: 'c' }, { id: 'd' }], 'c2'), // 与上一页重叠（乱序响应）
    page([{ id: 'e' }], null),
  ];
  const seq = new SequenceSnapshot({
    fetchPage: async (cursor) => pages.shift(),
    filterHash: 'cat=*', sortVersion: 'sv1',
  });
  seq.appendPage([{ id: 'a' }, { id: 'b' }], 'c1');
  assert.equal(await seq.getId(3), 'd');
  assert.equal(await seq.getId(4), 'e');
  assert.deepEqual(seq.ids, ['a', 'b', 'c', 'd', 'e'], '重叠分页不得产生重复');
  assert.equal(await seq.getId(5), null);
});

test('灯箱序列: 下架作品成为墓碑，左右键永不回跳', async () => {
  const seq = new SequenceSnapshot({ fetchPage: async () => page([], null), filterHash: 'x', sortVersion: 'sv1' });
  seq.appendPage([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }], null);
  seq.applyStatus({ b: 'gone', c: 'gone' });
  // 从 a 向右：跳过墓碑 b、c，直接到 d
  assert.deepEqual(await seq.nextAlive(0, 1), { index: 3, id: 'd' });
  // 从 d 向左：同样跳过 c、b 到 a
  assert.deepEqual(await seq.nextAlive(3, -1), { index: 0, id: 'a' });
  // 全部下架 → null
  seq.applyStatus({ a: 'gone', d: 'gone' });
  assert.equal(await seq.nextAlive(0, 1), null);
});

test('灯箱序列: 排序版本切换使快照作废', async () => {
  const seq = new SequenceSnapshot({
    fetchPage: async () => page([{ id: 'x' }], null, 'sv2'), // 服务端排序已变
    filterHash: 'x', sortVersion: 'sv1',
  });
  seq.appendPage([{ id: 'a' }], 'c1');
  await assert.rejects(() => seq.getId(5), /sort-version-changed/);
});

test('预加载: 任务绑定作品+变体身份，同身份并发去重', async () => {
  let fetchCount = 0;
  const loader = new ImageLoader({
    fetchImpl: async () => { fetchCount++; return { ok: true, blob: async () => ({}) }; },
    createObjectURL: () => 'obj:' + fetchCount,
    revokeObjectURL: () => {},
  });
  const [r1, r2] = await Promise.all([
    loader.load({ photoId: 'p1', variant: 'main', url: '/m/p1.jpg' }),
    loader.load({ photoId: 'p1', variant: 'main', url: '/m/p1.jpg' }),
  ]);
  assert.equal(fetchCount, 1, '同身份并发只发一次请求');
  assert.equal(r1.photoId, 'p1');
  assert.equal(r1.objectUrl, r2.objectUrl);
  const r3 = await loader.load({ photoId: 'p2', variant: 'main', url: '/m/p2.jpg' });
  assert.notEqual(r3.objectUrl, r1.objectUrl, '不同作品身份不同资源');
});

test('预加载: 快速切换时取消在途，关闭时释放全部对象资源', async () => {
  const revoked = [];
  const aborts = [];
  const loader = new ImageLoader({
    fetchImpl: (url, { signal }) => new Promise((res, rej) => {
      signal.addEventListener('abort', () => { aborts.push(url); rej(new DOMException('aborted', 'AbortError')); });
    }),
    createObjectURL: (b) => 'obj:' + Math.random(),
    revokeObjectURL: (u) => revoked.push(u),
  });
  const p1 = loader.load({ photoId: 'a', variant: 'main', url: '/a' }).catch(() => 'aborted-a');
  const p2 = loader.load({ photoId: 'b', variant: 'main', url: '/b' }).catch(() => 'aborted-b');
  loader.abortExcept([ImageLoader.key('b', 'main')]); // 快速切到 b：取消 a
  assert.equal(await p1, 'aborted-a');
  loader.dispose(); // 关闭灯箱：中止 b 并释放
  assert.equal(await p2, 'aborted-b');
  assert.deepEqual(aborts.sort(), ['/a', '/b']);

  // 缓存满逐出时释放最旧对象 URL
  const loader2 = new ImageLoader({
    fetchImpl: async () => ({ ok: true, blob: async () => ({}) }),
    createObjectURL: () => 'obj:' + Math.random().toString(36).slice(2),
    revokeObjectURL: (u) => revoked.push(u),
    maxCache: 2,
  });
  const urls = [];
  for (const id of ['x', 'y', 'z']) urls.push((await loader2.load({ photoId: id, variant: 'main', url: '/' + id })).objectUrl);
  assert.equal(loader2.cache.size, 2);
  assert.ok(revoked.includes(urls[0]), '最旧对象 URL 应被释放');
  loader2.dispose();
  assert.ok(revoked.includes(urls[1]) && revoked.includes(urls[2]), '关闭后全部释放');
});

test('防串图: 晚到的旧响应不能覆盖当前提交（token 模式）', async () => {
  // 模拟 lightbox.js 的 navToken 提交守卫
  const deferred = {};
  const loader = new ImageLoader({
    fetchImpl: (url) => new Promise((res) => { deferred[url] = () => res({ ok: true, blob: async () => ({}) }); }),
    createObjectURL: () => 'obj:' + Math.random().toString(36).slice(2),
    revokeObjectURL: () => {},
  });
  let navToken = 0;
  const committed = [];
  const show = async (id) => {
    const my = ++navToken;
    const rec = await loader.load({ photoId: id, variant: 'main', url: '/' + id });
    if (my !== navToken) return;          // 晚到的旧响应：丢弃
    committed.push(id);                   // 原子提交图+标题
  };
  const s1 = show('old');
  const s2 = show('new');
  deferred['/new']();                     // 新图先到
  await s2;
  deferred['/old']();                     // 旧图晚到
  await s1;
  assert.deepEqual(committed, ['new'], '旧图晚到不得覆盖当前标题');
});
