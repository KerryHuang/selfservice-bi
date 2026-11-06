import test from 'node:test';
import assert from 'node:assert/strict';
import { createCache, createRefreshGate } from '../cache.ts';
import type { Built } from '../sqlgen.ts';

const q = (text: string, v = 1): Built => ({ text, params: [{ name: 'today', type: 'date', value: '2026-11-02' }, { name: 'p0', type: 'float', value: v }] });
function fake() {
  let t = 1000, calls = 0, fail = false;
  const exec = async () => { calls++; if (fail) throw new Error('db'); return [{ n: calls }]; };
  return { exec, now: () => t, tick: (ms: number) => { t += ms; }, calls: () => calls, setFail: (f: boolean) => { fail = f; } };
}

test('同一查詢 TTL 內只查一次，參數不同視為不同查詢', async () => {
  const f = fake(), c = createCache(f.exec, { ttlMs: 600000, now: f.now });
  const a = await c.exec(q('SELECT 1')), b = await c.exec(q('SELECT 1'));
  assert.equal(f.calls(), 1); assert.deepEqual(b.rows, a.rows); assert.equal(b.fetchedAt, 1000);
  await c.exec(q('SELECT 1', 2));
  assert.equal(f.calls(), 2);
});

test('超過 TTL 重新查詢', async () => {
  const f = fake(), c = createCache(f.exec, { ttlMs: 600000, now: f.now });
  await c.exec(q('SELECT 1')); f.tick(600001);
  const r = await c.exec(q('SELECT 1'));
  assert.equal(f.calls(), 2); assert.equal(r.fetchedAt, 601001);
});

test('refresh replaces shared cache entry', async () => {
  const f = fake(), c = createCache(f.exec, { ttlMs: 600000, now: f.now });
  await c.exec(q('SELECT 1')); f.tick(5000);
  const r = await c.exec(q('SELECT 1'), { refresh: true });
  assert.equal(f.calls(), 2); assert.equal(r.fetchedAt, 6000);
  const later = await c.exec(q('SELECT 1')); // 其他使用者（不帶 refresh）拿到新結果
  assert.equal(later.fetchedAt, 6000); assert.equal(f.calls(), 2);
});

test('底層丟錯不寫入快取；進行中的同一查詢共用', async () => {
  const f = fake(), c = createCache(f.exec, { ttlMs: 600000, now: f.now });
  f.setFail(true);
  await assert.rejects(c.exec(q('SELECT 1')));
  f.setFail(false);
  await c.exec(q('SELECT 1'));
  assert.equal(f.calls(), 2);
  const [x, y] = await Promise.all([c.exec(q('SELECT 2')), c.exec(q('SELECT 2'))]);
  assert.equal(f.calls(), 3); assert.deepEqual(x, y);
});

test('重新整理節流：同一 viewer 60 秒內只放行一次，不同 viewer 各自計算', () => {
  let t = 0;
  const g = createRefreshGate({ windowMs: 60000, now: () => t });
  assert.equal(g.allow('sales'), true);
  t = 59999; assert.equal(g.allow('sales'), false); assert.equal(g.allow('owner'), true);
  t = 60000; assert.equal(g.allow('sales'), true);
});

test('重新整理節流：同一頁的多張卡片（10 秒內）算同一次重新整理，之後 60 秒內才擋', () => {
  let t = 0;
  const g = createRefreshGate({ now: () => t });
  assert.equal(g.allow('sales'), true);
  t = 3000; assert.equal(g.allow('sales'), true, '同一批卡片');
  t = 9000; assert.equal(g.allow('sales'), true, '同一批卡片（慢的）');
  t = 20000; assert.equal(g.allow('sales'), false, '60 秒內再按');
  t = 61000; assert.equal(g.allow('sales'), true);
});

test('過期的快取項目在寫入新項目時清掉，不會無限成長', async () => {
  const f = fake(), c = createCache(f.exec, { ttlMs: 1000, now: f.now });
  await c.exec(q('SELECT 1')); await c.exec(q('SELECT 2'));
  assert.equal(c.size(), 2);
  f.tick(1001);
  await c.exec(q('SELECT 3'));
  assert.equal(c.size(), 1);
});

test('快取總列數有上限，超過時淘汰最舊的', async () => {
  const c = createCache(async () => Array.from({ length: 40 }, (_, n) => ({ n })), { maxRows: 100 });
  for (let i = 0; i < 5; i++) await c.exec(q('SELECT ' + i));
  assert.equal(c.size(), 2);
  let calls = 0;
  const d = createCache(async () => { calls++; return Array.from({ length: 40 }, (_, n) => ({ n })); }, { maxRows: 100 });
  for (let i = 0; i < 5; i++) await d.exec(q('SELECT ' + i));
  await d.exec(q('SELECT 4')); assert.equal(calls, 5, '最新的還在');
  await d.exec(q('SELECT 0')); assert.equal(calls, 6, '最舊的已淘汰');
});

test('快取筆數有上限：沒有列的查詢也不會無限累積', async () => {
  const c = createCache(async () => [], { maxEntries: 3 });
  for (let i = 0; i < 10; i++) await c.exec(q('SELECT ' + i));
  assert.equal(c.size(), 3);
});

test('單筆超過總列數上限時不快取，也不影響回傳', async () => {
  const c = createCache(async () => Array.from({ length: 50 }, (_, n) => ({ n })), { maxRows: 10 });
  assert.equal((await c.exec(q('SELECT 1'))).rows.length, 50);
  assert.equal(c.size(), 0);
});
