// 以假的 exec 驗證：回傳結構、上限、錯誤對應、CRUD、HTTP 層。不連資料庫。
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { localToday } from '../engine.ts';
import { writeSeedWithStale } from './helpers.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp, MAX_BODY, MAX_DASHBOARDS, MAX_ITEM_BYTES, MAX_REPORTS } from '../app.ts';
import { assertSafeSelect } from '../guard.ts';
import { ServiceError } from '../service.ts';
import type { Exec, Row } from '../service.ts';
import type { Built } from '../sqlgen.ts';
import { createStore } from '../store.ts';
import { SEED_PATH } from '../store.ts'; // 測試一律以種子資料為 fixture，不依賴本機 data/store.json
import { TODAY, cols, cond, def, m } from './helpers.ts';

const seen: Built[] = [];
let handler: (q: Built) => Row[] | Promise<Row[]> = () => [];
const isDetail = (q: { text: string }): boolean => q.text.includes(' ORDER BY ') && !q.text.startsWith('SELECT DISTINCT');
const exec: Exec = async (q) => { assertSafeSelect(q.text); seen.push(q); return handler(q); };

type Call = (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: any }>;
async function withApp<T>(fn: (call: Call) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'app-'));
  writeSeedWithStale(join(dir, 'store.json'));
  const server = createApp({ exec, store: createStore(join(dir, 'store.json')), asOf: localToday() });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  const call: Call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  try { return await fn(call); } finally { server.close(); }
}

const custDef = def({ columns: cols('customer', 'amountLocal'), groups: [{ field: 'customer' }], metrics: [m('m1', 'sum', 'amountLocal'), m('m2', 'distinctOrders')] });

test('/api/run 彙總：回傳結構，並以第一個指標由大到小排序', async () => {
  seen.length = 0;
  handler = (q) => q.text.includes('GROUP BY')
    ? [{ g0: 'B 客戶', _n: 2, m_m1: 100, m_m2: 1 }, { g0: null, _n: 1, m_m1: 50, m_m2: 1 }, { g0: 'A 客戶', _n: 5, m_m1: 900.126, m_m2: 3 }]
    : [{ _n: 8, m_m1: 1050.126, m_m2: 5 }];
  await withApp(async (call) => {
    const r = await call('POST', '/api/run', { def: custDef, today: TODAY });
    assert.equal(r.status, 200);
    const b = r.body;
    assert.equal(b.ok, true); assert.equal(b.mode, 'summary'); assert.equal(b.count, 8); assert.equal(b.empty, false);
    assert.deepEqual(b.rows.map((x: any) => x._keys), [['A 客戶'], ['B 客戶'], ['（空白）']]);
    assert.deepEqual(b.rows[0], { _n: 5, _keys: ['A 客戶'], g0: 'A 客戶', m_m1: 900.13, m_m2: 3 });
    assert.deepEqual(b.total, { _n: 8, m_m1: 1050.13, m_m2: 5, _notes: [] });
    assert.deepEqual(b.columns.map((c: any) => [c.key, c.kind, c.fmt]), [['g0', 'group', 'text'], ['m_m1', 'metric', 'money'], ['m_m2', 'metric', 'int']]);
    assert.equal(b.truncated, false);
    assert.equal(seen.length, 2); // 分組查詢＋合計列查詢
    assert.ok(typeof b.meta.ms === 'number' && b.meta.queries.length === 2 && !('sql' in b.meta));
    const d = await call('POST', '/api/run', { def: custDef, today: TODAY, debug: true });
    assert.equal(d.body.meta.sql.length, 2);
  });
});

test('/api/run 彙總：合計列跨組幣別／單位不同 → 合計不顯示並附註', async () => {
  handler = (q) => q.text.includes('GROUP BY')
    ? [{ g0: 'A', _n: 1, m_m1: 10 }, { g0: 'B', _n: 1, m_m1: 20 }]
    : [{ _n: 2, m_m1: 30, _d_currency: 2 }];
  const d = def({ columns: cols('amount', 'customer', 'currency'), groups: [{ field: 'customer' }, { field: 'currency' }], metrics: [m('m1', 'sum', 'amount')] });
  handler = (q) => q.text.includes('GROUP BY')
    ? [{ g0: 'A', g1: 'USD', _n: 1, m_m1: 10 }, { g0: 'A', g1: 'TWD', _n: 1, m_m1: 20 }]
    : [{ _n: 2, m_m1: 30, _d_currency: 2 }];
  await withApp(async (call) => {
    const r = (await call('POST', '/api/run', { def: d })).body;
    assert.equal(r.total.m_m1, null);
    assert.match(r.total._notes[0], /幣別不同/);
    assert.equal(r.rows.length, 2);
  });
});

test('/api/run 彙總：分組數超過上限 → GROUP_OVERFLOW，不回半套結果', async () => {
  handler = (q) => q.text.includes('GROUP BY') ? Array.from({ length: 501 }, (_v, i) => ({ g0: 'c' + i, _n: 1, m_m1: 1, m_m2: 1 })) : [{ _n: 501, m_m1: 501, m_m2: 501 }];
  await withApp(async (call) => {
    const r = await call('POST', '/api/run', { def: custDef });
    assert.equal(r.status, 400);
    assert.equal(r.body.ok, false); assert.equal(r.body.errors[0].code, 'GROUP_OVERFLOW');
  });
  assert.match(seen.at(-1)!.text.length ? seen.filter((q) => q.text.includes('GROUP BY')).at(-1)!.text : '', / LIMIT 501$/);
});

test('/api/run 明細：多取 1 筆判斷截斷，截斷時另跑 COUNT 回真實筆數，日期轉成 YYYY-MM-DD', async () => {
  handler = (q) => isDetail(q) ? Array.from({ length: 2001 }, (_v, i) => ({ orderNo: 'SO' + i, orderDate: new Date(Date.UTC(2026, 10, 2)) })) : [{ _n: 57402 }];
  const d = def({ columns: cols('orderNo', 'orderDate'), mode: 'detail' });
  await withApp(async (call) => {
    const r = (await call('POST', '/api/run', { def: d, sort: { key: 'orderNo', dir: 'desc' } })).body;
    assert.equal(r.ok, true); assert.equal(r.mode, 'detail'); assert.equal(r.rows.length, 2000);
    assert.equal(r.truncated, true); assert.equal(r.limit, 2000); assert.equal(r.count, 57402); assert.equal(r.total, null);
    assert.deepEqual(r.rows[0], { orderNo: 'SO0', orderDate: '2026-11-02' });
    assert.deepEqual(Object.keys(r.columns[0]).sort(), ['align', 'chip', 'fmt', 'key', 'label', 'type']);
  });
  assert.match(seen.filter((q) => isDetail(q)).at(-1)!.text, /ORDER BY CASE WHEN .* DESC LIMIT \d+$/);
  assert.match(seen.at(-1)!.text, /COUNT/); // 截斷才補跑的筆數查詢
});

test('/api/run 驗證錯誤：HTTP 200、ok:false、不送出任何 SQL', async () => {
  seen.length = 0;
  const mixed = def({ columns: cols('amount'), metrics: [m('m1', 'sum', 'amount')] });
  await withApp(async (call) => {
    const r = await call('POST', '/api/run', { def: mixed });
    assert.equal(r.status, 200); assert.equal(r.body.ok, false); assert.equal(r.body.errors[0].code, 'MIXED_CURRENCY');
    const n = await call('POST', '/api/run', { def: def({ columns: cols('lineAmount', 'currency'), topic: 'shipment', groups: [{ field: 'currency' }], metrics: [m('m1', 'sum', 'lineAmount')] }) });
    assert.equal(n.body.errors[0].code, 'NOT_SUMMABLE');
    const g = await call('POST', '/api/run', { def: def({ columns: cols('customer', 'orderType', 'salesperson'), groups: [{ field: 'customer' }, { field: 'orderType' }, { field: 'salesperson' }], metrics: [m('m1', 'count')] }) });
    assert.ok(g.body.errors.some((e: any) => e.code === 'GROUP_LIMIT'));
    const nd = await call('POST', '/api/run', { def: def({ columns: cols('customer'), groups: [{ field: 'customer' }], metrics: [m('m1', 'onTimeRate')] }) });
    assert.equal(nd.body.errors[0].code, 'NEEDS_RELATED');
  });
  assert.equal(seen.length, 0);
});

test('/api/run 不信任輸入：型別錯誤、過大、非 JSON → 400', async () => {
  await withApp(async (call) => {
    assert.equal((await call('POST', '/api/run', { def: 'x' })).status, 400);
    assert.equal((await call('POST', '/api/run', { def: { ...custDef, columns: 'x' } })).status, 400);
    assert.equal((await call('POST', '/api/run', { def: custDef, today: '2026-13-45' })).status, 400);
    assert.equal((await call('POST', '/api/run', { def: { ...custDef, filters: { logic: 'all', rows: Array.from({ length: 31 }, () => cond({ field: 'customer', op: 'in', values: ['a'] })) } } })).status, 400);
    assert.equal((await call('GET', '/api/nope')).status, 404);
  });
});

test('資料庫錯誤 → 清楚的錯誤碼，不讓前端壞掉', async () => {
  await withApp(async (call) => {
    handler = () => { throw new ServiceError('DB_ERROR', '資料庫執行錯誤', 500); };
    const r = await call('POST', '/api/run', { def: custDef });
    assert.equal(r.status, 500); assert.equal(r.body.ok, false); assert.equal(r.body.errors[0].code, 'DB_ERROR');
    handler = () => { throw new Error('boom'); };
    const e = await call('POST', '/api/run', { def: custDef });
    assert.equal(e.status, 500); assert.equal(e.body.errors[0].code, 'INTERNAL');
    assert.ok(!JSON.stringify(e.body).includes('boom'));
  });
});

test('/api/chart：指標卡、長條、圓餅檢查、失效 widget', async () => {
  const w = (o: object) => ({ id: 'w', title: 't', type: 'bar', size: 'M', reportId: 'r-cust', topic: 'orderLine', category: { field: 'customer' }, metric: { agg: 'sum', field: 'amountLocal', label: '' }, dateField: 'orderDate', ...o });
  const dash = { filters: { range: 'last12m', from: '', to: '', customers: [], orderTypes: [] } };
  await withApp(async (call) => {
    handler = (q) => q.text.includes('GROUP BY') ? [{ g0: 'A', _n: 2, m_w: 30 }, { g0: 'B', _n: 1, m_w: 5 }] : [{ _n: 3, m_w: 35 }];
    const bar = (await call('POST', '/api/chart', { widget: w({}), reportId: 'r-cust', dash, today: TODAY })).body;
    assert.equal(bar.ok, true); assert.equal(bar.kind, 'bar');
    assert.deepEqual(bar.points, [{ key: 'A', label: 'A', value: 30, n: 2 }, { key: 'B', label: 'B', value: 5, n: 1 }]);
    assert.equal(bar.total, 35); assert.equal(bar.ex.applied.length, 1);
    assert.ok(seen.at(-1)!.params.some((p) => p.value === '2025-11-03'));
    handler = () => [{ _n: 3, m_w: 35 }];
    const card = (await call('POST', '/api/chart', { widget: w({ type: 'metric', category: null, metricName: '接單金額', unit: '本幣' }), reportId: 'r-cust', dash, today: TODAY })).body;
    assert.deepEqual([card.kind, card.value, card.name, card.unit, card.n, card.fmt], ['metric', 35, '接單金額', '本幣', 3, 'money']);
    handler = (q) => q.text.includes('GROUP BY') ? [{ g0: 'A', _n: 1, m_w: 1 }] : [{ _n: 1, m_w: 1 }];
    const pie = (await call('POST', '/api/chart', { widget: w({ type: 'pie', metric: { agg: 'avg', field: 'amountLocal' } }), reportId: 'r-cust', dash })).body;
    assert.equal(pie.ok, false); assert.match(pie.typeError, /可加總/);
    const gone = (await call('POST', '/api/chart', { widget: w({ reportId: 'r-gone' }), reportId: 'r-gone', dash })).body;
    assert.deepEqual([gone.ok, gone.invalid, gone.code], [false, true, 'REPORT_MISSING']);
    const removed = (await call('POST', '/api/chart', { widget: w({}), reportId: 'r-month', dash })).body;
    assert.equal(removed.code, 'FIELD_REMOVED');
    const tbl = (await call('POST', '/api/chart', { widget: w({ type: 'table', category: null, metric: null }), reportId: 'r-overdue', dash: { filters: { range: 'all' } } })).body;
    assert.equal(tbl.kind, 'table'); assert.equal(tbl.result.mode, 'detail');
  });
});

test('/api/drill：點選分類只進參數、帶交期欄位時自動加關聯、回傳 count 與 truncated', async () => {
  const w = { id: 'w', title: 't', type: 'bar', reportId: 'r-cust', topic: 'orderLine', category: { field: 'customer' }, metric: { agg: 'sum', field: 'amountLocal' }, dateField: 'orderDate' };
  await withApp(async (call) => {
    seen.length = 0;
    handler = (q) => isDetail(q) ? [{ orderNo: 'SO1', orderDate: new Date(Date.UTC(2026, 0, 5)), dueStatus: '如期' }] : [{ _n: 7, m_w: 123.456 }];
    const r = (await call('POST', '/api/drill', { widget: w, reportId: 'r-cust', clicked: { key: "x'; DROP TABLE t--" }, dash: { filters: { range: 'all' } } })).body;
    assert.equal(r.ok, true); assert.equal(r.value, 123.46); assert.equal(r.count, 7); assert.equal(r.truncated, false);
    assert.equal(r.categoryText, "客戶 = x'; DROP TABLE t--");
    assert.equal(r.rows[0].dueStatus, '如期');
    assert.deepEqual(r.columns.map((c: any) => c.key), ['orderNo', 'orderDate', 'customer', 'partName', 'qty', 'unit', 'amountLocal', 'basisDue', 'dueStatus']);
    const detail = seen.find((q) => isDetail(q))!;
    assert.ok(!detail.text.includes('DROP') && detail.params.some((p) => p.value === "x'; DROP TABLE t--"));
    assert.ok(detail.text.includes('GROUP BY w2.order_line_id')); // 預設下鑽欄位含交期狀態
    const metricSql = seen.find((q) => !isDetail(q))!;
    assert.ok(!metricSql.text.includes('GROUP BY w2.order_line_id'));
    const blank = await call('POST', '/api/drill', { widget: w, reportId: 'r-cust', clicked: { key: '（空白）' } });
    assert.ok(seen.at(-1)!.text.includes('IS NULL') && blank.body.ok);
    handler = (q) => isDetail(q) ? Array.from({ length: 2001 }, () => ({ orderNo: 'x' })) : [{ _n: 5000, m_w: 1 }];
    const big = (await call('POST', '/api/drill', { widget: w, reportId: 'r-cust', clicked: { key: 'A' } })).body;
    assert.equal(big.truncated, true); assert.equal(big.rows.length, 2000); assert.equal(big.count, 5000);
    const bad = (await call('POST', '/api/drill', { widget: { ...w, metric: { agg: 'sum', field: 'amountLocal; DROP' } }, reportId: 'r-cust', clicked: { key: 'A' } })).body;
    assert.equal(bad.ok, false);
  });
});

test('/api/chart-options：圓餅依資料判斷', async () => {
  await withApp(async (call) => {
    handler = () => Array.from({ length: 9 }, (_v, i) => ({ g0: 'c' + i, _n: 1, m_w: 1 }));
    const r = (await call('POST', '/api/chart-options', { reportId: 'r-cust', category: 'customer', metric: { agg: 'count' }, gran: 'month' })).body;
    const pie = r.options.find((o: any) => o.type === 'pie');
    assert.equal(pie.enabled, false); assert.match(pie.reason, /最多 8 項/);
    assert.equal(r.options.find((o: any) => o.type === 'line').enabled, false);
  });
});

test('/api/chart-options：分類數超過分組上限（GROUP_OVERFLOW）→ 圓餅停用，不是整個請求失敗', async () => {
  await withApp(async (call) => {
    handler = (q) => q.text.includes('GROUP BY') ? Array.from({ length: 501 }, (_v, i) => ({ g0: 'd' + i, _n: 1, m_w: 1 })) : [{ _n: 501, m_w: 501 }];
    const r = (await call('POST', '/api/chart-options', { reportId: 'r-month', category: 'orderDate', metric: { agg: 'sum', field: 'amountLocal' }, gran: 'day' })).body;
    assert.equal(r.ok, true);
    const pie = r.options.find((o: any) => o.type === 'pie');
    assert.equal(pie.enabled, false); assert.match(pie.reason, /最多 8 項/);
    assert.equal(r.options.find((o: any) => o.type === 'bar').enabled, true);
  });
});

test('GET /api/meta 不含 sql；enum 選項來自 DISTINCT 查詢', async () => {
  handler = () => [{ v: 'TWD' }, { v: 'USD' }];
  await withApp(async (call) => {
    const r = (await call('GET', '/api/meta')).body;
    assert.ok(!JSON.stringify(r).includes('"sql"') && !JSON.stringify(r).includes('sales_order'));
    const cur = r.FIELDS.orderLine.find((f: any) => f.id === 'currency');
    assert.deepEqual(cur.opts, ['TWD', 'USD']);
    assert.deepEqual(r.FIELDS.orderLine.find((f: any) => f.id === 'dueStatus').opts, ['未到期', '如期', '提早', '延誤', '逾期未交']);
    assert.equal(r.FIELDS.orderLine.find((f: any) => f.id === 'qty').opts, null);
    assert.ok(r.OPS.text && r.RANGE_LABELS.last12m && r.limits.detailRows === 2000);
  });
  assert.ok(seen.filter((q) => q.text.startsWith('SELECT DISTINCT ') && q.text.endsWith(' LIMIT 200')).length >= 4);
});

const ADMIN = { 'X-Viewer': 'admin' }, SALES = { 'X-Viewer': 'sales' };

test('CRUD：種子資料可讀、管理員新增／更新／刪除、驗證', async () => {
  await withApp(async (call) => {
    const reports = (await call('GET', '/api/reports', undefined, ADMIN)).body, dashes = (await call('GET', '/api/dashboards', undefined, ADMIN)).body;
    assert.equal(reports.length, 17); assert.equal(dashes.length, 5);
    assert.equal((await call('GET', '/api/state', undefined, SALES)).body.home, 'd-ops');
    // 種子每份報表／儀表板重新送回去都過驗證
    for (const r of reports) assert.equal((await call('PUT', '/api/reports/' + r.id, r, ADMIN)).status, 200, r.id);
    for (const d of dashes) assert.equal((await call('PUT', '/api/dashboards/' + d.id, d, ADMIN)).status, 200, d.id);
    const created = await call('POST', '/api/reports', { ...reports[0], id: undefined, name: '新報表' }, ADMIN);
    assert.equal(created.status, 201); assert.match(created.body.id, /^r\d+$/);
    assert.equal((await call('GET', '/api/reports/' + created.body.id)).body.name, '新報表');
    assert.equal((await call('POST', '/api/reports', { name: 'x', topic: 'nope', columns: [] })).status, 400);
    assert.equal((await call('POST', '/api/reports', { topic: 'orderLine' })).status, 400);
    assert.equal((await call('POST', '/api/dashboards', { name: 'D', widgets: [{ type: 'evil' }] })).status, 400);
    assert.equal((await call('PUT', '/api/reports/none', reports[0], ADMIN)).status, 404);
    assert.equal((await call('DELETE', '/api/reports/' + created.body.id, undefined, ADMIN)).status, 200);
    assert.equal((await call('DELETE', '/api/reports/' + created.body.id, undefined, ADMIN)).status, 404);
    assert.equal((await call('PUT', '/api/role-home', { role: 'production', id: 'd-stale' }, ADMIN)).status, 404); // 個人版不能當角色首頁
    assert.equal((await call('PUT', '/api/role-home', { role: 'production', id: 'd-pur' }, ADMIN)).status, 200);
    assert.equal((await call('GET', '/api/state', undefined, { 'X-Viewer': 'production' })).body.home, 'd-pur');
    assert.equal((await call('PUT', '/api/role-home', { role: 'production', id: 'zzz' }, ADMIN)).status, 404);
  });
});

test('角色儀表板與個人版：主管儲存變個人版、管理員更新提示、還原、權限', async () => {
  await withApp(async (call) => {
    const d = (await call('GET', '/api/dashboards/d-ops')).body;
    const p = await call('PUT', '/api/dashboards/d-ops', { ...d, name: '我的' }, SALES);
    assert.equal(p.status, 200); assert.equal(p.body.kind, 'personal'); assert.equal(p.body.baseId, 'd-ops');
    assert.equal((await call('GET', '/api/dashboards/d-ops')).body.version, 1);
    let st = (await call('GET', '/api/state', undefined, SALES)).body;
    assert.ok(st.dashboards.some((x: any) => x.id === p.body.id) && !st.dashboards.some((x: any) => x.id === 'd-ops'));
    assert.deepEqual(st.roles.map((r: any) => r.code), ['sales', 'production', 'purchasing', 'owner', 'admin']);
    assert.equal((await call('PUT', '/api/dashboards/d-ops', d, ADMIN)).body.version, 2);
    st = (await call('GET', '/api/state', undefined, SALES)).body;
    assert.equal(st.dashboards.find((x: any) => x.id === p.body.id).roleUpdated, true);
    assert.equal((await call('POST', '/api/dashboards/d-ops/restore', {}, SALES)).status, 200);
    st = (await call('GET', '/api/state', undefined, SALES)).body;
    assert.ok(st.dashboards.some((x: any) => x.id === 'd-ops'));
    assert.deepEqual((await call('GET', '/api/state', undefined, { 'X-Viewer': 'production' })).body.dashboards.map((x: any) => x.id), ['d-prod']);
    const shared = (await call('GET', '/api/reports/r-cust')).body;
    const ro = await call('PUT', '/api/reports/r-cust', shared, SALES);
    assert.equal(ro.status, 403); assert.equal(ro.body.errors[0].code, 'SHARED_READONLY');
    const del = await call('DELETE', '/api/dashboards/d-ops', undefined, SALES);
    assert.equal(del.status, 403); assert.equal(del.body.errors[0].code, 'ADMIN_ONLY');
    const rs = await call('POST', '/api/reset', undefined, SALES);
    assert.equal(rs.status, 403); assert.equal(rs.body.errors[0].code, 'ADMIN_ONLY');
    assert.equal((await call('PUT', '/api/default-dashboard', { id: 'd-ops' }, ADMIN)).status, 404);
  });
});

test('種子 Dashboard 的每張卡都能經 /api/chart 計算（不報驗證錯誤；過期看板三張卡維持失效判定）', async () => {
  handler = (q) => q.text.includes('GROUP BY') ? [{ g0: 'A', g1: 'B', _n: 1, m_w: 1 }] : [{ _n: 1, m_w: 1 }];
  const store = JSON.parse(readFileSync(SEED_PATH, 'utf8'));
  store.dashboards.push(JSON.parse(readFileSync(new URL('./fixtures/stale-dashboard.json', import.meta.url), 'utf8')));
  await withApp(async (call) => {
    const codes: string[] = [];
    for (const d of store.dashboards) for (const w of d.widgets) {
      const r = (await call('POST', '/api/chart', { widget: w, reportId: w.reportId, dash: d })).body;
      if (r.invalid) codes.push(r.code);
      else assert.ok(r.ok || r.typeError, d.id + '/' + w.id + ' ' + JSON.stringify(r.errors));
    }
    assert.deepEqual(codes, ['REPORT_MISSING', 'FIELD_REMOVED']);
  });
});

async function getText(path: string): Promise<{ status: number; text: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'app-'));
  copyFileSync(SEED_PATH, join(dir, 's.json'));
  const server = createApp({ exec, store: createStore(join(dir, 's.json')), asOf: localToday() });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const res = await fetch('http://127.0.0.1:' + (server.address() as AddressInfo).port + path);
  const text = await res.text();
  server.close();
  return { status: res.status, text };
}

test('靜態檔：GET / 回 web/index.html（接 API 的前端）', async () => {
  const web = await getText('/');
  assert.equal(web.status, 200);
  assert.match(web.text, /<script id="engine">/);
  assert.match(web.text, /Engine\.init\(|E\.init\(/);       // 目錄由 /api/meta 載入
  assert.doesNotMatch(web.text, /getData|mulberry32/);   // 本機假資料引擎已移除（localStorage 只存角色選擇）
});

test('web/index.html：內嵌 script 語法正確；前端不含任何 SQL 字樣', () => {
  const html = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');
  const scripts = [...html.matchAll(/<script id="(\w+)">([\s\S]*?)<\/script>/g)];
  assert.deepEqual(scripts.map((m) => m[1]), ['engine', 'app']);
  for (const m of scripts) assert.doesNotThrow(() => new Function(m[2]), m[1]);
  assert.doesNotMatch(html, /\b(SELECT|INSERT|UPDATE|DELETE)\s+\w+.*\bFROM\b/);
  // 需要資料的呼叫都走 API
  for (const path of ['/api/run', '/api/chart', '/api/drill', '/api/chart-options', '/api/meta', '/api/state', '/api/reports', '/api/dashboards', '/api/role-home'])
    assert.ok(html.includes("'" + path), path);
});

test('web/index.html：角色與個人版——帶 X-Viewer／X-Refresh、可還原', () => {
  const html = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');
  for (const s of ["'X-Viewer'", "'X-Refresh'", "/restore'", "'/api/role-home'", '已調整', '還原成角色預設', '角色儀表板已更新', '另存一份', '設為共用報表', '資料基準日'])
    assert.ok(html.includes(s), s);
});

test('POST /api/reset（管理員）把報表與儀表板還原成種子', async () => {
  await withApp(async (call) => {
    const seed = (await call('GET', '/api/state', undefined, ADMIN)).body;
    assert.equal((await call('POST', '/api/reports', { ...seed.reports[0], id: undefined, name: '暫時' }, ADMIN)).status, 201);
    assert.equal((await call('DELETE', '/api/dashboards/d-stale', undefined, ADMIN)).status, 200);
    const mid = (await call('GET', '/api/state', undefined, ADMIN)).body;
    assert.equal(mid.reports.length, seed.reports.length + 1);
    assert.equal(mid.dashboards.length, seed.dashboards.length - 1);
    const r = await call('POST', '/api/reset', undefined, ADMIN);
    assert.equal(r.status, 200);
    const after = (await call('GET', '/api/state', undefined, ADMIN)).body;
    assert.equal(after.reports.length, 17);
    assert.deepEqual(after.dashboards.map((d: { id: string }) => d.id), ['d-ops', 'd-prod', 'd-pur', 'd-owner']);
    assert.equal(after.home, null, '管理員沒有首頁');
    for (const [role, home] of [['sales', 'd-ops'], ['production', 'd-prod'], ['purchasing', 'd-pur'], ['owner', 'd-owner']]) {
      const st = (await call('GET', '/api/state', undefined, { 'X-Viewer': role })).body;
      assert.equal(st.home, home, role);
      assert.ok(!st.dashboards.some((d: { id: string }) => d.id === 'd-stale'), role + ' 看不到管理員的測試儀表板');
    }
  });
});

test('ratio with zero denominator is null', async () => {
  handler = () => [{ _n: 3, m_m1: null }];
  const d = def({ related: { delivery: true }, columns: cols('customer'), metrics: [m('m1', 'ratio:onTime')] });
  await withApp(async (call) => {
    const r = (await call('POST', '/api/run', { def: d })).body;
    assert.equal(r.ok, true); assert.equal(r.total.m_m1, null);
    assert.equal(r.columns.find((c: any) => c.key === 'm_m1').fmt, 'rate');
  });
});

const wOpt = (o: object) => ({ id: 'w', title: 't', type: 'bar', size: 'M', reportId: 'r-cust', topic: 'orderLine', category: { field: 'customer' }, metric: { agg: 'sum', field: 'amountLocal', label: '' }, dateField: 'orderDate', ...o });
test('widget 排行：sort asc＋limit 取最小的 N 項、遞增；累計占比最後一點 100', async () => {
  handler = (q) => q.text.includes('GROUP BY') ? [{ g0: 'A', _n: 1, m_w: 50 }, { g0: 'B', _n: 1, m_w: 10 }, { g0: 'C', _n: 1, m_w: 30 }, { g0: 'D', _n: 1, m_w: 10 }] : [{ _n: 4, m_w: 100 }];
  await withApp(async (call) => {
    const asc = (await call('POST', '/api/chart', { widget: wOpt({ options: { sort: 'asc', limit: 2 } }), reportId: 'r-cust' })).body;
    assert.deepEqual(asc.points.map((p: any) => p.value), [10, 10]);
    const cum = (await call('POST', '/api/chart', { widget: wOpt({ options: { sort: 'desc', cumulative: true } }), reportId: 'r-cust' })).body;
    assert.deepEqual(cum.points.map((p: any) => p.key), ['A', 'C', 'B', 'D']);
    assert.deepEqual(cum.points.map((p: any) => p.cumPct), [50, 80, 90, 100]);
    const top = (await call('POST', '/api/chart', { widget: wOpt({ options: { sort: 'desc', limit: 2, cumulative: true } }), reportId: 'r-cust' })).body;
    assert.deepEqual(top.points.map((p: any) => p.cumPct), [50, 80]); // 占比以全部分類為分母
    const bad = (await call('POST', '/api/chart', { widget: wOpt({ metric: { agg: 'avg', field: 'amountLocal' }, options: { cumulative: true } }), reportId: 'r-cust' })).body;
    assert.equal(bad.ok, false); assert.equal(bad.errors[0].code, 'CUMULATIVE_NOT_SUMMABLE');
  });
});

test('指標卡與前 N 期平均比：前四週 10、20、30、40，本週 50 → baseline 25、deltaPct 100', async () => {
  handler = (q) => {
    if (!q.text.includes('GROUP BY')) return [{ _n: 5, m_w: 50 }];
    return [{ g0: '2026-10-05', _n: 1, m_w: 10 }, { g0: '2026-10-12', _n: 1, m_w: 20 }, { g0: '2026-10-19', _n: 1, m_w: 30 }, { g0: '2026-10-26', _n: 1, m_w: 40 }];
  };
  await withApp(async (call) => {
    seen.length = 0;
    const w = wOpt({ type: 'metric', category: null, options: { range: 'thisWeek', compare: { periods: 4, gran: 'week' } } });
    const r = (await call('POST', '/api/chart', { widget: w, reportId: 'r-cust', dash: { filters: { range: 'last12m' } }, today: TODAY })).body;
    assert.equal(r.ok, true); assert.equal(r.value, 50);
    assert.deepEqual(r.compare, { baseline: 25, deltaPct: 100, periods: 4, gran: 'week' });
    const cmp = seen.find((q) => q.text.includes('GROUP BY'))!;
    const dates = cmp.params.filter((p) => p.type === 'date').map((p) => p.value);
    assert.ok(dates.includes('2026-10-05') && dates.includes('2026-11-01'), JSON.stringify(dates));
    assert.ok(r.ex.applied.some((t: string) => t.includes('本週')));
    handler = (q) => q.text.includes('GROUP BY') ? [] : [{ _n: 5, m_w: 50 }];
    const z = (await call('POST', '/api/chart', { widget: w, reportId: 'r-cust', today: '2026-11-03' })).body;
    assert.deepEqual(z.compare, { baseline: 0, deltaPct: null, periods: 4, gran: 'week' });
  });
});

test('被任何儀表板（含別人的個人版）引用的報表不能刪', async () => {
  await withApp(async (call) => {
    const r = await call('POST', '/api/reports', { name: '我的', topic: 'orderLine', related: {}, columns: [{ field: 'orderNo', label: '' }], filters: { logic: 'all', rows: [] }, mode: 'detail', groups: [], metrics: [] }, SALES);
    assert.equal(r.status, 201);
    const w = { id: 'x1', title: 't', type: 'table', size: 'M', reportId: 'r-cust', topic: 'orderLine', category: null, metric: null, dateField: null };
    assert.equal((await call('POST', '/api/dashboards', { name: '我的看板', filters: { range: 'all', from: '', to: '', customers: [], orderTypes: [] }, widgets: [w] }, SALES)).status, 201);
    const del = await call('DELETE', '/api/reports/r-cust', undefined, ADMIN);
    assert.equal(del.status, 403); assert.equal(del.body.errors[0].code, 'REPORT_IN_USE');
    assert.equal((await call('DELETE', '/api/reports/' + r.body.id, undefined, SALES)).status, 200); // 沒被引用的照刪
  });
});

test('非管理員只能讀／跑自己看得到的報表與儀表板，不能改沒派給自己的角色儀表板', async () => {
  await withApp(async (call) => {
    const r = await call('POST', '/api/reports', { name: '業務私人', topic: 'orderLine', related: {}, columns: [{ field: 'orderNo', label: '' }], filters: { logic: 'all', rows: [] }, mode: 'detail', groups: [], metrics: [] }, SALES);
    const OWNER = { 'X-Viewer': 'owner' }, PROD = { 'X-Viewer': 'production' };
    assert.equal((await call('GET', '/api/reports/' + r.body.id, undefined, OWNER)).status, 404);
    assert.equal((await call('GET', '/api/reports/' + r.body.id, undefined, SALES)).status, 200);
    const w = { id: 'x', title: 't', type: 'table', size: 'M', reportId: r.body.id, topic: 'orderLine', category: null, metric: null, dateField: null };
    assert.equal((await call('POST', '/api/chart', { widget: w, reportId: r.body.id }, OWNER)).status, 404);
    assert.equal((await call('POST', '/api/chart', { widget: w, reportId: 'r-cust', dashId: 'd-ops' }, PROD)).status, 404);
    assert.equal((await call('GET', '/api/dashboards/d-ops', undefined, PROD)).status, 404);
    assert.equal((await call('GET', '/api/dashboards/d-prod', undefined, PROD)).status, 200);
    const d = (await call('GET', '/api/dashboards/d-ops', undefined, ADMIN)).body;
    assert.equal((await call('PUT', '/api/dashboards/d-ops', d, PROD)).status, 403);
  });
});

test('web/index.html：角色儀表板在檢視模式改篩選，連管理員也不存檔（避免主管誤收「已更新」）', () => {
  const html = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');
  assert.ok(html.includes("if (!V.edit && cur && cur.kind === 'role') { redrawGrid(); return; }"));
});

test('儀表板改名：管理員改角色儀表板名稱、主管改名存成個人版；前端有改名按鈕', async () => {
  await withApp(async (call) => {
    const d = (await call('GET', '/api/dashboards/d-prod', undefined, ADMIN)).body;
    const a = await call('PUT', '/api/dashboards/d-prod', { ...d, name: '生產週會' }, ADMIN);
    assert.equal(a.status, 200); assert.equal(a.body.name, '生產週會'); assert.equal(a.body.kind, 'role');
    const PROD = { 'X-Viewer': 'production' };
    const p = await call('PUT', '/api/dashboards/d-prod', { ...a.body, name: '我的生產' }, PROD);
    assert.equal(p.body.kind, 'personal'); assert.equal(p.body.name, '我的生產'); assert.equal(p.body.baseId, 'd-prod');
  });
  const html = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');
  assert.ok(html.includes("A['dash-rename']") && (html.match(/data-act="dash-rename"/g) || []).length === 2);
});

/* ---------- 公開站的數量與大小限制 ---------- */
const reportBody = (name: string) => ({ name, topic: 'orderLine', related: {}, columns: [{ field: 'orderNo', label: '' }], filters: { logic: 'all', rows: [] }, mode: 'detail', groups: [], metrics: [] });
const dashBody = (name: string) => ({ name, filters: { range: 'all', from: '', to: '', customers: [], orderTypes: [] }, widgets: [] });

test('報表達上限：第 201 份回 409 LIMIT_REACHED', async () => {
  await withApp(async (call) => {
    const st = (await call('GET', '/api/state', undefined, ADMIN)).body;
    for (let i = st.reports.length; i < MAX_REPORTS; i++) assert.equal((await call('POST', '/api/reports', reportBody('r' + i), ADMIN)).status, 201);
    const r = await call('POST', '/api/reports', reportBody('超過'), ADMIN);
    assert.equal(r.status, 409);
    assert.equal(r.body.errors[0].code, 'LIMIT_REACHED');
  });
});

test('儀表板達上限：第 51 份回 409 LIMIT_REACHED', async () => {
  await withApp(async (call) => {
    const st = (await call('GET', '/api/state', undefined, ADMIN)).body;
    for (let i = st.dashboards.length; i < MAX_DASHBOARDS; i++) assert.equal((await call('POST', '/api/dashboards', dashBody('d' + i), ADMIN)).status, 201);
    const r = await call('POST', '/api/dashboards', dashBody('超過'), ADMIN);
    assert.equal(r.status, 409);
    assert.equal(r.body.errors[0].code, 'LIMIT_REACHED');
  });
});

test('上限以全站為準：別的角色的項目也算，達上限時仍可修改既有項目', async () => {
  await withApp(async (call) => {
    const st = (await call('GET', '/api/state', undefined, ADMIN)).body;
    let last = '';
    for (let i = st.reports.length; i < MAX_REPORTS; i++) last = (await call('POST', '/api/reports', reportBody('r' + i), SALES)).body.id;
    assert.equal((await call('POST', '/api/reports', reportBody('超過'), { 'X-Viewer': 'owner' })).status, 409);
    assert.equal((await call('PUT', '/api/reports/' + last, reportBody('改名'), SALES)).status, 200);
  });
});

test('單一項目過大：序列化超過 32 KiB 回 400', async () => {
  await withApp(async (call) => {
    const body = { ...reportBody('大'), note: 'x'.repeat(MAX_ITEM_BYTES) };
    const r = await call('POST', '/api/reports', body, ADMIN);
    assert.equal(r.status, 400);
    assert.match(r.body.errors[0].msg, /過大/);
  });
});

test('請求過大：超過 64 KiB 回 413', async () => {
  await withApp(async (call) => {
    const r = await call('POST', '/api/reports', { ...reportBody('大'), note: 'x'.repeat(MAX_BODY + 1) }, ADMIN);
    assert.equal(r.status, 413);
  });
});

test('種子項目都在單項大小上限內', () => {
  const seed = JSON.parse(readFileSync(SEED_PATH, 'utf8'));
  for (const it of [...seed.reports, ...seed.dashboards]) assert.ok(Buffer.byteLength(JSON.stringify(it)) <= MAX_ITEM_BYTES, it.id);
  assert.ok(seed.reports.length < MAX_REPORTS && seed.dashboards.length < MAX_DASHBOARDS);
});

test('前端標示：標題與示範資料聲明', async () => {
  const web = await getText('/');
  assert.match(web.text, /<title>自助營運分析<\/title>/);
  assert.match(web.text, /示範資料，內容皆為虛構/);
});

const XSS = 'x"><img src=x onerror=alert(1)>';
const goodWidget = { id: 'w1', title: 't', type: 'metric', size: 'S', reportId: 'r-month', topic: 'orderLine', metric: { agg: 'count', field: null, label: '' } };

test('存檔：報表的結構欄位不接受標記', async () => {
  await withApp(async (call) => {
    const good = (over: object) => ({ name: 'x', ...custDef, ...over });
    const c = custDef.filters;
    for (const over of [
      { filters: { ...c, rows: [{ id: XSS, field: 'customer', op: 'in', values: ['a'] }] } },
      { metrics: [{ id: XSS, agg: 'count', field: null, label: '' }] },
      { metrics: [{ id: 'm1', agg: XSS, field: null, label: '' }] },
      { groups: [{ field: 'customer', gran: XSS }] },
      { mode: XSS }
    ]) {
      const r = await call('POST', '/api/reports', good(over), { 'X-Viewer': 'sales' });
      assert.equal(r.status, 400, JSON.stringify(over));
    }
  });
});

test('存檔：卡片的結構欄位不接受標記，size 只能是 S／M／L', async () => {
  await withApp(async (call) => {
    for (const over of [{ id: XSS }, { size: XSS }, { size: 'XL' }, { reportId: XSS }, { topic: XSS }, { dateField: XSS }, { category: { field: XSS } }, { options: { linkDashboardId: XSS } }]) {
      const r = await call('POST', '/api/dashboards', { name: 'x', widgets: [{ ...goodWidget, ...over }] }, { 'X-Viewer': 'sales' });
      assert.equal(r.status, 400, JSON.stringify(over));
    }
    assert.equal((await call('POST', '/api/dashboards', { name: 'x', widgets: [goodWidget] }, { 'X-Viewer': 'sales' })).status, 201);
  });
});

test('主題名稱是 Object 內建屬性時不會 500 也存不進去', async () => {
  await withApp(async (call) => {
    for (const topic of ['__proto__', 'constructor', 'toString']) {
      assert.equal((await call('POST', '/api/reports', { ...custDef, name: 'x', topic }, { 'X-Viewer': 'sales' })).status, 400, topic);
      const run = await call('POST', '/api/run', { def: { ...custDef, topic } });
      assert.ok(run.status < 500, topic + ' ' + run.status);
      assert.equal(run.body.ok, false, topic);
    }
  });
});

test('存檔：報表引用不存在的欄位回 400', async () => {
  await withApp(async (call) => {
    for (const over of [
      { columns: [{ field: 'nope', label: '' }] },
      { groups: [{ field: 'nope' }] },
      { metrics: [{ id: 'm1', agg: 'sum', field: 'nope', label: '' }] },
      { filters: { logic: 'all', rows: [{ id: 'c1', field: 'nope', op: 'eq', value: 'a' }] } }
    ]) {
      assert.equal((await call('POST', '/api/reports', { ...custDef, name: 'x', ...over }, { 'X-Viewer': 'sales' })).status, 400, JSON.stringify(over));
    }
  });
});

test('前端：儀表板篩選的已選值放進 summary 前要跳脫', async () => {
  const web = await getText('/');
  assert.match(web.text, /<summary>' \+ esc\(ddLabel\(label, sel\)\) \+ '<\/summary>/);
});
