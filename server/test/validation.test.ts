// 不依賴資料的規則斷言（驗證、判定、widget 狀態、日期區間）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { allErrors, buildExtra, normDash, normWidget, pieCheck, resolveRange, validateConditions, widgetStatus } from '../engine.ts';
import { cols, cond, def, m } from './helpers.ts';

const codes = (d: ReturnType<typeof def>, extra = [] as ReturnType<typeof cond>[]): string[] => allErrors(d, extra).map((e) => e.code);

test('(d) 不可加總：出貨主題的明細金額、訂購數量；訂單明細的訂單總額', () => {
  const ship = (field: string) => def({ topic: 'shipment', columns: cols(field, 'currency'), groups: [{ field: 'currency' }], metrics: [m('m1', 'sum', field)] });
  const e1 = allErrors(ship('lineAmount'), []);
  assert.equal(e1[0].code, 'NOT_SUMMABLE');
  assert.match(String(e1[0].msg), /重複計算/);
  assert.deepEqual(codes(ship('orderedQty')), ['NOT_SUMMABLE']);
  const o = def({ columns: cols('orderTotal', 'currency'), groups: [{ field: 'currency' }], metrics: [m('m1', 'sum', 'orderTotal')] });
  assert.deepEqual(codes(o), ['NOT_SUMMABLE']);
  const price = def({ columns: cols('unitPrice', 'currency'), groups: [{ field: 'currency' }], metrics: [m('m1', 'sum', 'unitPrice')] });
  assert.deepEqual(codes(price), ['NOT_SUMMABLE']);
  const avgPrice = def({ columns: cols('unitPrice', 'currency'), groups: [{ field: 'currency' }], metrics: [m('m1', 'avg', 'unitPrice')] });
  // notSummable 欄位四種彙總一律擋
  assert.deepEqual(codes(avgPrice), ['NOT_SUMMABLE']);
  const local = def({ columns: cols('amountLocal'), metrics: [m('m1', 'sum', 'amountLocal')] });
  assert.deepEqual(codes(local), []);
});

test('(e) 原幣加總：需依幣別分組或單一幣別', () => {
  const mk = (groups: object[], rows: object[] = [], logic = 'all') => def({ columns: cols('amount', 'currency', 'customer'), filters: { logic, rows }, groups, metrics: [m('m1', 'sum', 'amount')] });
  const e = allErrors(mk([]), []);
  assert.equal(e[0].code, 'MIXED_CURRENCY');
  assert.equal((e[0].fixes as unknown[]).length, 2);
  assert.deepEqual(codes(mk([{ field: 'customer' }])), ['MIXED_CURRENCY']); // 只依客戶分組仍被擋
  assert.deepEqual(codes(mk([{ field: 'currency' }])), []);
  const usd = cond({ field: 'currency', op: 'in', values: ['USD'] });
  assert.deepEqual(codes(mk([], [usd])), []);
  assert.deepEqual(codes(mk([], [usd], 'any')), ['MIXED_CURRENCY']); // 邏輯「任一」時單一幣別條件不算數
  assert.deepEqual(codes(mk([], [cond({ field: 'currency', op: 'in', values: ['USD', 'JPY'] })])), ['MIXED_CURRENCY']); // 兩種幣別不算單一
  assert.deepEqual(codes(mk([]), [cond({ field: 'currency', op: 'in', values: ['JPY'] })]), []); // Dashboard 篩選（extra）也算
});

test('(e) 數量與單位：MIXED_UNIT', () => {
  const q = (groups: object[]) => def({ columns: cols('qty', 'unit'), groups, metrics: [m('m1', 'sum', 'qty')] });
  assert.deepEqual(codes(q([])), ['MIXED_UNIT']);
  assert.deepEqual(codes(q([{ field: 'unit' }])), []);
  const s = def({ topic: 'shipment', columns: cols('shipQty', 'unit'), metrics: [m('m1', 'sum', 'shipQty')] });
  assert.deepEqual(codes(s), ['MIXED_UNIT']);
});

test('(f) 條件未填完 → COND_INCOMPLETE（含各型別）', () => {
  const one = (c: Record<string, unknown>) => allErrors(def({ columns: cols('orderNo'), mode: 'detail', filters: { logic: 'all', rows: [cond(c)] } }), []);
  assert.equal(one({ field: 'customer', op: 'in', values: [] })[0].code, 'COND_INCOMPLETE');
  assert.equal(one({ field: 'partName', op: 'contains', value: '  ' })[0].code, 'COND_INCOMPLETE');
  assert.equal(one({ field: 'qty', op: 'between', value: '5', value2: '1' })[0].code, 'COND_INCOMPLETE');
  assert.equal(one({ field: 'qty', op: 'between', value: '5' })[0].code, 'COND_INCOMPLETE');
  assert.equal(one({ field: 'orderDate', op: 'custom', from: '2026-02-01', to: '2026-01-01' })[0].code, 'COND_INCOMPLETE');
  assert.equal(one({ field: 'orderDate', op: 'in', values: ['x'] })[0].code, 'COND_INCOMPLETE'); // 運算子不屬於該型別
  assert.equal(one({ field: 'nope', op: 'eq', value: 'x' })[0].code, 'COND_INCOMPLETE');
  assert.deepEqual(one({ field: 'partName', op: 'empty' }), []);
  assert.deepEqual(one({ field: 'orderDate', op: 'thisMonth' }), []);
  assert.match(String(one({ field: 'customer', op: 'in', values: [] })[0].msg), /^第 1 個條件：/);
});

test('GROUP_LIMIT／GROUP_TYPE／NO_METRIC／FIELD_MISSING', () => {
  const base = { columns: cols('customer', 'orderType', 'salesperson', 'qty'), metrics: [m('m1', 'count')] };
  assert.ok(codes(def({ ...base, groups: [{ field: 'customer' }, { field: 'orderType' }, { field: 'salesperson' }] })).includes('GROUP_LIMIT'));
  assert.deepEqual(codes(def({ ...base, groups: [{ field: 'customer' }, { field: 'orderType' }] })), []);
  assert.deepEqual(codes(def({ ...base, groups: [{ field: 'qty' }] })), ['GROUP_TYPE']);
  assert.deepEqual(codes(def({ ...base, metrics: [], groups: [] })), ['NO_METRIC']);
  assert.deepEqual(codes(def({ ...base, groups: [{ field: 'currency' }] })), ['FIELD_MISSING']);
  assert.deepEqual(codes(def({ topic: 'x' })), ['NO_TOPIC']);
  assert.deepEqual(codes(def({ mode: 'detail' })), ['NO_COLUMNS']);
});

test('NEEDS_RELATED／NEEDS_DELIVERY：達交率／逾期未交需要訂單明細＋交期結果', () => {
  const mk = (topic: string, delivery: boolean, agg: string) => def({ topic, related: { delivery }, columns: cols('customer'), groups: [{ field: 'customer' }], metrics: [m('m1', agg)] });
  assert.deepEqual(codes(mk('orderLine', false, 'onTimeRate')), ['NEEDS_RELATED']);
  assert.deepEqual(codes(mk('orderLine', false, 'overdueCount')), ['NEEDS_DELIVERY']);
  assert.deepEqual(codes(mk('orderLine', true, 'onTimeRate')), []);
  assert.deepEqual(codes(mk('shipment', true, 'onTimeRate')), ['BAD_AGG']); // 出貨明細沒有達交率
  assert.deepEqual(codes(mk('orderLine', false, 'distinctShips')), ['AGG_TOPIC']);
  assert.deepEqual(codes(mk('shipment', false, 'distinctShips')), []);
  // 交期欄位放進欄位清單但沒勾交期結果
  assert.deepEqual(codes(def({ columns: cols('dueStatus'), mode: 'detail' })), ['NEEDS_DELIVERY']);
});

test('Dashboard 篩選（extra）也驗證', () => {
  const d = def({ columns: cols('orderNo'), mode: 'detail' });
  assert.deepEqual(codes(d, [cond({ field: 'customer', op: 'in', values: [] })]), ['COND_INCOMPLETE']);
  assert.deepEqual(codes(d, [cond({ field: 'dueStatus', op: 'in', values: ['如期'] })]), ['COND_INCOMPLETE']);
});

test('數值欄位以外不能 sum/avg（AGG_TYPE）；metric 欄位須在已選欄位', () => {
  assert.deepEqual(codes(def({ columns: cols('partNo'), metrics: [m('m1', 'sum', 'partNo')] })), ['AGG_TYPE']);
  assert.deepEqual(codes(def({ columns: cols('customer'), metrics: [m('m1', 'sum', 'amountLocal')] })), ['FIELD_MISSING']);
});

test('日期區間（今天=2026-11-02）', () => {
  const T = '2026-11-02';
  assert.deepEqual(resolveRange('thisMonth', '', '', T), { from: '2026-11-01', to: '2026-11-30' });
  assert.deepEqual(resolveRange('lastMonth', '', '', T), { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(resolveRange('last3m', '', '', T), { from: '2026-08-03', to: T });
  assert.deepEqual(resolveRange('last12m', '', '', T), { from: '2025-11-03', to: T });
  assert.deepEqual(resolveRange('thisYear', '', '', T), { from: '2026-01-01', to: '2026-12-31' });
  assert.equal(resolveRange('all', '', '', T), null);
  assert.deepEqual(resolveRange('last12m', '', '', '2026-03-31'), { from: '2025-04-01', to: '2026-03-31' });
});

test('buildExtra：日期套在 widget.dateField；客戶／訂單類型；沒有該欄位的主題記入 notApplied', () => {
  const report = def({ columns: cols('orderNo') });
  const w = normWidget({ type: 'metric', topic: 'orderLine', dateField: 'orderDate', metric: { agg: 'count' } });
  const dash = normDash({ filters: { range: 'last12m', customers: ['A'], orderTypes: ['修護'] } });
  const ex = buildExtra(w, report, dash, '2026-11-02');
  assert.deepEqual(ex.conds.map((c) => c.field + ':' + c.op), ['orderDate:custom', 'customer:in', 'orderType:in']);
  assert.equal(ex.conds[0].from, '2025-11-03');
  // widget 的日期欄位是交期欄位、但報表沒勾交期 → 日期篩選不套用
  const w2 = normWidget({ type: 'metric', topic: 'orderLine', dateField: 'firstShip', metric: { agg: 'count' } });
  assert.deepEqual(buildExtra(w2, report, dash, '2026-11-02').notApplied, ['日期']);
  // range=all 不產生日期條件
  assert.equal(buildExtra(w, report, normDash({ filters: { range: 'all' } }), '2026-11-02').conds.length, 0);
  assert.throws(() => normDash({ filters: { range: "x'; DROP" } }));
});

test('widgetStatus：失效偵測（三張卡）', () => {
  const cust = def({ columns: cols('customer', 'orderNo', 'amountLocal'), metrics: [m('m1', 'sum', 'amountLocal')], groups: [{ field: 'customer' }] });
  const month = def({ columns: cols('orderDate', 'amountLocal') });
  const w = (o: Record<string, unknown>) => normWidget({ type: 'bar', topic: 'orderLine', category: { field: 'customer' }, metric: { agg: 'sum', field: 'amountLocal' }, ...o });
  assert.equal(widgetStatus(w({}), null).code, 'REPORT_MISSING');
  assert.equal(widgetStatus(w({}), month).code, 'FIELD_REMOVED');
  assert.equal(widgetStatus(w({}), cust).ok, true);
  assert.equal(widgetStatus(w({ topic: 'shipment' }), cust).code, 'TOPIC_CHANGED');
  assert.equal(widgetStatus(w({ type: 'table' }), cust).ok, true);
  const rate = normWidget({ type: 'metric', topic: 'orderLine', metric: { agg: 'onTimeRate' } });
  assert.equal(widgetStatus(rate, cust).code, 'FIELD_REMOVED'); // 報表不含交期結果
});

test('圓餅檢查：比率／平均不可、負數不可、超過 8 項不可', () => {
  assert.match(String(pieCheck('onTimeRate', [{ value: 1 }])), /可加總/);
  assert.match(String(pieCheck('avg', [])), /可加總/);
  assert.match(String(pieCheck('sum', [{ value: -1 }])), /負數/);
  assert.match(String(pieCheck('sum', Array.from({ length: 9 }, () => ({ value: 1 })))), /最多 8 項/);
  assert.equal(pieCheck('sum', [{ value: 1 }]), null);
});

test('validateConditions 單獨使用', () => {
  const d = def({ columns: cols('orderNo'), mode: 'detail', filters: { logic: 'all', rows: [cond({ field: 'customer', op: 'in', values: [] })] } });
  assert.equal(validateConditions(d).length, 1);
});

test('比率型彙總的驗證：未知比率 BAD_AGG、未勾相關資料 NEEDS_RELATED、不能畫圓餅', async () => {
  const { allErrors: ae, pieCheck: pc, metricFmt: mf, metricUnit: mu } = await import('../engine.ts');
  const { def: dd, cols: cc, m: mm } = await import('./helpers.ts');
  assert.equal(ae(dd({ columns: cc('customer'), groups: [{ field: 'customer' }], metrics: [mm('m1', 'ratio:nope')] }), [])[0].code, 'BAD_AGG');
  assert.equal(ae(dd({ columns: cc('customer'), groups: [{ field: 'customer' }], metrics: [mm('m1', 'ratio:onTime')] }), [])[0].code, 'NEEDS_RELATED');
  assert.match(pc('ratio:onTime', [{ value: 1 }]) || '', /可加總/);
  assert.equal(mf('orderLine', { agg: 'ratio:onTime', field: null }), 'rate');
  assert.equal(mu('orderLine', { agg: 'ratio:onTime', field: null }), '%');
});

test('widget.options 驗證：limit 1～50、compare periods 1～12、gran 只能 week／month、range 白名單', () => {
  const base = { id: 'w', title: 't', type: 'bar', size: 'M', reportId: 'r', topic: 'orderLine', category: { field: 'customer' }, metric: { agg: 'count', field: null, label: '' } };
  assert.deepEqual(normWidget({ ...base, options: { sort: 'desc', limit: 10, cumulative: true, linkDashboardId: 'd-ops', range: 'lastWeek' } }).options,
    { sort: 'desc', limit: 10, cumulative: true, linkDashboardId: 'd-ops', range: 'lastWeek' });
  assert.equal(normWidget(base).options, undefined);
  for (const bad of [{ limit: 0 }, { limit: 51 }, { limit: 2.5 }, { sort: 'up' }, { compare: { periods: 13, gran: 'week' } }, { compare: { periods: 4, gran: 'day' } }, { range: 'custom' }, { range: 'nope' }])
    assert.throws(() => normWidget({ ...base, options: bad }), /options/, JSON.stringify(bad));
});
