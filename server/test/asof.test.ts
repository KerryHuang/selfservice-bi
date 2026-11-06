// 基準日與啟動流程：對真實 Demo 資料庫跑 HTTP 層。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createApp } from '../app.ts';
import { openDemoDb } from '../db.ts';
import { resolveRange, weekStart } from '../engine.ts';
import { createStore, SEED_PATH } from '../store.ts';

type Call = (method: string, path: string, body?: unknown, viewer?: string) => Promise<{ status: number; body: any }>;

async function withDemo<T>(asOf: string, fn: (call: Call) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'asof-'));
  copyFileSync(SEED_PATH, join(dir, 'store.json'));
  const demo = openDemoDb(join(dir, 'demo.db'), asOf);
  const server = createApp({ exec: demo.exec, store: createStore(join(dir, 'store.json')), asOf });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  const call: Call = async (method, path, body, viewer = 'admin') => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'X-Viewer': viewer }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  try { return await fn(call); } finally { server.close(); demo.close(); }
}

/** 回應裡有沒有任何非 0 的數值。 */
function hasNumber(x: unknown): boolean {
  if (typeof x === 'number') return x !== 0 && Number.isFinite(x);
  if (Array.isArray(x)) return x.some(hasNumber);
  if (x && typeof x === 'object') return Object.entries(x).some(([k, v]) => !['periods', 'limit'].includes(k) && hasNumber(v));
  return false;
}

async function assertRoleHomes(call: Call): Promise<void> {
  for (const role of ['sales', 'production', 'purchasing', 'owner']) {
    const st = (await call('GET', '/api/state', undefined, role)).body;
    const dash = st.dashboards.find((d: { id: string }) => d.id === st.home);
    assert.ok(dash, role + ' 沒有首頁');
    assert.ok(dash.widgets.length > 0, role);
    for (const w of dash.widgets) {
      const { meta: _meta, ...r } = (await call('POST', '/api/chart', { widget: w, reportId: w.reportId, dash }, role)).body;
      assert.equal(r.ok, true, role + '/' + w.title + ' ' + JSON.stringify(r).slice(0, 200));
      assert.ok(hasNumber(r), role + '/' + w.title + ' 全為 0：' + JSON.stringify(r).slice(0, 300));
    }
  }
}

test('基準日來自資料庫', async () => {
  await withDemo('2026-01-15', async (call) => {
    const meta = (await call('GET', '/api/meta')).body;
    assert.equal(meta.today, '2026-01-15');
    assert.equal(meta.asOf, '2026-01-15');
    const report = JSON.parse(readFileSync(SEED_PATH, 'utf8')).reports.find((r: { id: string }) => r.id === 'r-month');
    const run = (await call('POST', '/api/run', { def: report })).body;
    assert.equal(run.meta.today, '2026-01-15');
  });
});

test('基準日舊了仍有資料', async () => {
  await withDemo('2026-01-15', assertRoleHomes);
});

for (const asOf of ['2026-11-06', '2027-01-01', '2026-11-02']) {
  test('4 個角色首頁都有資料：' + asOf, async () => {
    await withDemo(asOf, assertRoleHomes);
  });
}

test('所有種子報表可執行', async () => {
  const seed = JSON.parse(readFileSync(SEED_PATH, 'utf8'));
  await withDemo('2026-11-06', async (call) => {
    for (const r of seed.reports) {
      const res = (await call('POST', '/api/run', { def: r })).body;
      assert.equal(res.ok, true, r.id + ' ' + JSON.stringify(res).slice(0, 200));
      assert.ok(res.rows.length > 0, r.id + ' 沒有資料');
    }
  });
});

test('啟動完成前不 listen：第一次連上就有資料', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'boot-'));
  const port = 30000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', fileURLToPath(new URL('../index.ts', import.meta.url))], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir }, stdio: 'ignore'
  });
  try {
    const base = 'http://127.0.0.1:' + port;
    const deadline = Date.now() + 15000;
    let up = false;
    while (!up && Date.now() < deadline) {
      try { up = (await fetch(base + '/api/health')).ok; } catch { await new Promise((r) => setTimeout(r, 25)); }
    }
    assert.ok(up, '站台沒有啟動');
    const meta = await (await fetch(base + '/api/meta')).json() as any;
    assert.deepEqual(meta.optsErrors, {});
    assert.ok(meta.FIELDS.orderLine.find((f: { id: string }) => f.id === 'customer').opts.length >= 12);
  } finally {
    child.kill();
  }
});

test('week key across year boundary：週一起算', () => {
  assert.equal(weekStart('2027-01-01'), '2026-12-28');
  assert.equal(weekStart('2026-12-28'), '2026-12-28');
  assert.equal(weekStart('2027-01-03'), '2026-12-28'); // 週日屬於前一個週一
  assert.deepEqual(resolveRange('lastWeek', undefined, undefined, '2027-01-02'), { from: '2026-12-21', to: '2026-12-27' });
  assert.deepEqual(resolveRange('thisWeek', undefined, undefined, '2027-01-02'), { from: '2026-12-28', to: '2027-01-02' });
  assert.deepEqual(resolveRange('last8w', undefined, undefined, '2027-01-02'), { from: '2026-11-09', to: '2027-01-02' });
});
