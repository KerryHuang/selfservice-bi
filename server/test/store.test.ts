import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore, Forbidden, SEED_PATH } from '../store.ts';

const BASE = new URL('./fixtures/store-base.json', import.meta.url);
function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'store-')), p = join(dir, 'store.json');
  copyFileSync(BASE, p);
  return { dir, p, store: createStore(p) };
}
const dash = (name: string) => ({ id: '', name, filters: { range: 'all', from: '', to: '', customers: [], orderTypes: [] }, widgets: [] });

test('個人版：主管儲存角色儀表板 → 建個人版，角色版不變；管理員更新 → version+1、提示；還原 → 回角色版', async () => {
  const { store } = fresh();
  const p = await store.saveDashboard('sales', 'd-ops', { ...dash('我的營運') });
  assert.equal(p.kind, 'personal'); assert.equal(p.baseId, 'd-ops'); assert.equal(p.baseVersion, 1); assert.equal(p.ownerId, 'sales');
  assert.equal(store.get('dashboards', 'd-ops')!.version, 1);
  let vs = store.visibleState('sales');
  assert.equal(vs.dashboards.filter((d) => d.id === p.id).length, 1);
  assert.equal(vs.dashboards.some((d) => d.id === 'd-ops'), false);
  assert.equal(vs.home, p.id);
  // 第二次儲存覆寫同一份個人版
  const p2 = await store.saveDashboard('sales', 'd-ops', { ...dash('我的營運 2') });
  assert.equal(p2.id, p.id);
  await store.saveDashboard('admin', 'd-ops', { ...dash('營運總覽 v2'), roles: ['sales'] });
  assert.equal(store.get('dashboards', 'd-ops')!.version, 2);
  vs = store.visibleState('sales');
  assert.equal(vs.dashboards.find((d) => d.id === p.id)!.roleUpdated, true);
  await store.restoreDashboard('sales', 'd-ops');
  vs = store.visibleState('sales');
  assert.ok(vs.dashboards.some((d) => d.id === 'd-ops' && !d.roleUpdated));
  assert.equal(vs.home, 'd-ops');
});

test('deleting role dashboard keeps personal copy as standalone', async () => {
  const { store } = fresh();
  const p = await store.saveDashboard('sales', 'd-ops', dash('我的'));
  await store.removeDashboard('admin', 'd-ops');
  const kept = store.get('dashboards', p.id)!;
  assert.equal(kept.kind, 'personal'); assert.equal(kept.baseId, undefined); assert.equal(kept.baseVersion, undefined);
  assert.ok(store.visibleState('sales').dashboards.some((d) => d.id === p.id));
  assert.equal(store.state().roleHome.sales, undefined);
});

test('可見範圍：只看到派給自己角色的；管理員看全部角色儀表板；別人的個人版不可改', async () => {
  const { store } = fresh();
  assert.equal(store.visibleState('production').dashboards.length, 0);
  assert.equal(store.visibleState('admin').dashboards.length, 2);
  const p = await store.saveDashboard('sales', 'd-ops', dash('我的'));
  await assert.rejects(store.saveDashboard('owner', p.id, dash('x')), (e: Forbidden) => e.code === 'NOT_OWNER');
  await assert.rejects(store.removeDashboard('sales', 'd-stale'), (e: Forbidden) => e.code === 'ADMIN_ONLY');
  assert.equal(store.visibleState('admin').dashboards.some((d) => d.id === p.id), false);
});

test('共用報表只有管理員能改；主管建立的報表是私人報表', async () => {
  const { store } = fresh();
  const r = store.get('reports', 'r-cust')!;
  await assert.rejects(store.saveReport('sales', 'r-cust', { ...r }), (e: Forbidden) => e.code === 'SHARED_READONLY');
  const mine = await store.createReport('sales', { ...r, id: undefined as never, shared: true, name: '我的' });
  assert.equal(mine.shared, false); assert.equal(mine.ownerId, 'sales');
  assert.equal(store.visibleState('sales').reports.find((x) => x.id === 'r-cust')!.readonly, true);
  assert.equal(store.visibleState('owner').reports.some((x) => x.id === mine.id), false);
  const ok = await store.saveReport('admin', 'r-cust', { ...r, name: '改名' });
  assert.equal(ok.name, '改名'); assert.equal(ok.shared, true);
  assert.equal(JSON.stringify(store.state()).includes('"readonly"'), false); // 衍生欄位不落檔
});

test('首次啟動：store.json 不存在且有給種子 → 以種子開局並落檔', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-')), p = join(dir, 'store.json');
  const seed = JSON.parse(readFileSync(SEED_PATH, 'utf8'));
  const store = createStore(p, SEED_PATH);
  assert.equal(store.state().reports.length, seed.reports.length);
  assert.equal(store.state().dashboards.length, seed.dashboards.length);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(existsSync(p));
});
