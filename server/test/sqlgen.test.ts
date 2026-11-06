import test from 'node:test';
import assert from 'node:assert/strict';
import { allErrors } from '../engine.ts';
import { buildAggregate, buildDetail, buildDistinct, groupExpr, inlineParams } from '../sqlgen.ts';
import type { Built } from '../sqlgen.ts';
import { TODAY, cols, cond, def, m } from './helpers.ts';

const common = (d: ReturnType<typeof def>, extra = [] as ReturnType<typeof cond>[]) => ({
  topic: d.topic, related: d.related, logic: d.filters.logic, conds: d.filters.rows, extra, today: TODAY
});
const agg = (d: ReturnType<typeof def>, extra = [] as ReturnType<typeof cond>[], more: object = {}): Built =>
  buildAggregate({ ...common(d, extra), groups: d.groups, metrics: d.metrics, ...more });

test('白名單外的欄位／運算子／彙總：驗證擋下，產生器也不收', () => {
  const d1 = def({ columns: cols('hacker'), mode: 'detail' });
  assert.equal(allErrors(d1, [])[0].code, 'FIELD_UNKNOWN');
  const d2 = def({ columns: cols('customer'), mode: 'detail', filters: { logic: 'all', rows: [cond({ field: 'customer', op: 'LIKE', values: ['x'] })] } });
  assert.equal(allErrors(d2, [])[0].code, 'COND_INCOMPLETE');
  const d3 = def({ columns: cols('amountLocal'), groups: [], metrics: [m('m1', 'sumDropTable', 'amountLocal')] });
  assert.equal(allErrors(d3, [])[0].code, 'BAD_AGG');
  assert.throws(() => def({ columns: cols('amountLocal'), groups: [], metrics: [m('m1', 'sum; DROP TABLE x', 'amountLocal')] }), /含不合法字元/);
  const d4 = def({ columns: cols('orderDate'), groups: [{ field: 'orderDate', gran: 'year' }], metrics: [m('m1', 'count')] });
  assert.ok(allErrors(d4, []).some((e) => e.code === 'BAD_GRAN'));
  const d5 = def({ columns: cols('qty'), groups: [], metrics: [m('bad:id', 'count')] });
  assert.ok(allErrors(d5, []).some((e) => e.code === 'BAD_METRIC_ID'));
  assert.throws(() => def({ columns: cols('qty'), groups: [], metrics: [m('m1 ]; DROP', 'count')] }), /含不合法字元/);
  // 產生器本身也不接受白名單外的東西（縱深防禦）
  assert.throws(() => buildDetail({ ...common(d1), fields: ['hacker'], limit: 10 }), /白名單/);
  assert.throws(() => buildAggregate({ ...common(d3), groups: [], metrics: [m('m1', 'sumDropTable', 'amountLocal') as never] }), /白名單/);
  assert.throws(() => buildDetail({ ...common(d2), conds: d2.filters.rows, fields: ['customer'], limit: 10 }), /不支援的條件/);
  assert.throws(() => buildAggregate({ ...common(d4), groups: [{ field: 'x]; DROP' }], metrics: [] }), /白名單/);
});

test('注入字串只出現在參數，不出現在 SQL 文字', () => {
  const evil = ["'; DROP TABLE x--", '1 OR 1=1', "') OR ('1'='1", 'x%'];
  const d = def({
    columns: cols('customer', 'partName', 'qty'), mode: 'detail',
    filters: { logic: 'all', rows: [
      cond({ field: 'partName', op: 'contains', value: evil[0] }),
      cond({ field: 'partName', op: 'eq', value: evil[1] }),
      cond({ field: 'customer', op: 'in', values: evil }),
      cond({ field: 'qty', op: 'gt', value: '1 OR 1=1' })
    ] }
  });
  // qty 的值 '1 OR 1=1' 經 parseFloat 只剩 1（數值參數），其餘是文字參數
  assert.deepEqual(allErrors(d, []), []);
  const b = buildDetail({ ...common(d), fields: ['customer', 'partName', 'qty'], limit: 100 });
  for (const e of evil) assert.ok(!b.text.includes(e), '不應出現在 SQL：' + e);
  assert.ok(!/DROP/i.test(b.text) && !b.text.includes('1=1'));
  const vals = b.params.map((p) => p.value);
  assert.ok(vals.includes("%'; DROP TABLE x--%") && vals.includes('1 OR 1=1') && vals.includes("') OR ('1'='1"));
  assert.ok(b.params.some((p) => p.type === 'float' && p.value === 1));
  assert.match(b.text, /IN \(@p\d+, @p\d+, @p\d+, @p\d+\)/); // IN 清單逐一參數化
  // 同樣的字串用在 Dashboard 篩選（extra）也只進參數
  const ex = [cond({ field: 'customer', op: 'in', values: evil })];
  const b2 = agg(def({ columns: cols('amountLocal'), metrics: [m('m1', 'count')] }), ex);
  for (const e of evil) assert.ok(!b2.text.includes(e));
  // LIKE 的萬用字元被跳脫
  const lk = buildDetail({ ...common(def({ filters: { logic: 'all', rows: [cond({ field: 'partName', op: 'contains', value: '50%_[a]' })] }, columns: cols('partName'), mode: 'detail' })), fields: ['partName'], limit: 5 });
  assert.ok(lk.params.some((p) => p.value === '%50\\%\\_\\[a]%'));
  assert.match(lk.text, /ESCAPE/);
});

test('數值條件值不是數字 → 驗證擋下，不會進 SQL', () => {
  const d = def({ columns: cols('qty'), mode: 'detail', filters: { logic: 'all', rows: [cond({ field: 'qty', op: 'gt', value: "1; DROP TABLE x" })] } });
  // parseFloat 取前綴 1，驗證通過但進的是數值參數；完全非數字則被擋
  assert.deepEqual(allErrors(d, []), []);
  const d2 = def({ columns: cols('qty'), mode: 'detail', filters: { logic: 'all', rows: [cond({ field: 'qty', op: 'gt', value: "abc'--" })] } });
  assert.equal(allErrors(d2, [])[0].code, 'COND_INCOMPLETE');
  const d3 = def({ columns: cols('orderDate'), mode: 'detail', filters: { logic: 'all', rows: [cond({ field: 'orderDate', op: 'custom', from: 'not-a-date', to: '2026-02-01' })] } });
  assert.equal(allErrors(d3, [])[0].code, 'COND_INCOMPLETE');
  assert.throws(() => cond({ field: 'orderDate', op: 'custom', from: "2026-01-01'; DROP", to: '2026-02-01' }), /含不合法字元/);
});

test('所有輸出都是單一 SELECT、無分號', () => {
  const d = def({ columns: cols('customer', 'amountLocal'), groups: [{ field: 'customer' }], metrics: [m('m1', 'sum', 'amountLocal'), m('m2', 'distinctOrders')] });
  for (const b of [agg(d), agg(d, [], { groups: [], withDims: true }), buildDetail({ ...common(d), fields: ['customer'], limit: 10 }), buildDistinct('orderLine', 'customer', 200, TODAY)]) {
    assert.match(b.text, /^SELECT /);
    assert.ok(!b.text.includes(';'));
  }
});

test('達交率 SQL：分母明確列四種狀態，分子兩種，分母 0 回 NULL', () => {
  const d = def({ related: { delivery: true }, columns: cols('dueStatus'), groups: [{ field: 'dueStatus' }], metrics: [m('m1', 'onTimeRate')] });
  assert.deepEqual(allErrors(d, []), []);
  const sql = agg(d).text;
  assert.ok(sql.includes("IN ('如期', '提早', '延誤', '逾期未交') THEN 1 ELSE 0 END) AS r_onTime_d"));
  assert.ok(sql.includes("IN ('如期', '提早') THEN 1 ELSE 0 END) AS r_onTime_n"));
  assert.ok(!/<> '未到期'|NOT IN/.test(sql), '不可用 <> 未到期 當分母');
  assert.match(sql, /\* 100 \/ NULLIF\(SUM\(r_onTime_d\), 0\)/);
});

test('交期子查詢只在 related.delivery 且用到交期欄位時出現', () => {
  const noDel = def({ columns: cols('customer'), groups: [{ field: 'customer' }], metrics: [m('m1', 'count')] });
  assert.ok(!agg(noDel).text.includes('GROUP BY w2.order_line_id'));
  const withDel = def({ related: { delivery: true }, columns: cols('dueStatus'), groups: [{ field: 'dueStatus' }], metrics: [m('m1', 'count')] });
  assert.ok(agg(withDel).text.includes('GROUP BY w2.order_line_id'));
  // 勾了交期但沒用到交期欄位 → 不白跑子查詢
  const unused = def({ related: { delivery: true }, columns: cols('customer'), groups: [{ field: 'customer' }], metrics: [m('m1', 'count')] });
  assert.ok(!agg(unused).text.includes('GROUP BY w2.order_line_id'));
  // 沒勾交期卻用交期欄位：驗證擋下（NEEDS_DELIVERY），產生器也拒絕
  const bad = def({ columns: cols('dueStatus'), mode: 'detail' });
  assert.equal(allErrors(bad, [])[0].code, 'NEEDS_DELIVERY');
  assert.throws(() => buildDetail({ ...common(bad), fields: ['dueStatus'], limit: 5 }), /相關資料/);
  const badCond = def({ columns: cols('customer'), mode: 'detail', filters: { logic: 'all', rows: [cond({ field: 'dueStatus', op: 'in', values: ['如期'] })] } });
  assert.equal(allErrors(badCond, [])[0].code, 'COND_INCOMPLETE');
  // 出貨主題沒有 related 定義
  assert.ok(!buildDetail({ topic: 'shipment', related: { delivery: true }, logic: 'all', conds: [], extra: [], today: TODAY, fields: ['shipNo'], limit: 3 }).text.includes('GROUP BY w2.order_line_id'));
});

test('日期分組：day → date、month → substr(…, 1, 7)；空字串與 NULL 併組', () => {
  assert.equal(groupExpr('orderLine', { field: 'orderDate', gran: 'day' }), '(h.order_date)');
  assert.equal(groupExpr('orderLine', { field: 'orderDate', gran: 'month' }), 'substr((h.order_date), 1, 7)');
  assert.equal(groupExpr('orderLine', { field: 'orderDate' }), 'substr((h.order_date), 1, 7)');
  assert.match(groupExpr('orderLine', { field: 'customer' }), /^NULLIF\(/);
});

test('明細模式 LIMIT 多取 1 筆；彙總 LIMIT 多取 1 組；日期區間用 today 解析', () => {
  const d = def({ columns: cols('orderNo'), mode: 'detail', filters: { logic: 'all', rows: [cond({ field: 'orderDate', op: 'last3m' })] } });
  const b = buildDetail({ ...common(d), fields: ['orderNo'], limit: 2000 });
  assert.match(b.text, / LIMIT 2001$/);
  assert.deepEqual(b.params.filter((p) => p.type === 'date').map((p) => p.value), [TODAY, '2026-08-03', TODAY]); // @today、起、迄
  const g = agg(def({ columns: cols('customer'), groups: [{ field: 'customer' }], metrics: [m('m1', 'count')] }), [], { limit: 500 });
  assert.match(g.text, / LIMIT 501$/);
});

test('合計列查詢：不分組、帶維度計數；原幣欄位用幣別、數量用單位', () => {
  const d = def({ columns: cols('amount', 'qty', 'currency', 'unit'), groups: [{ field: 'currency' }, { field: 'unit' }], metrics: [m('m1', 'sum', 'amount'), m('m2', 'sum', 'qty')] });
  const t = agg(d, [], { groups: [], withDims: true }).text;
  assert.ok(!t.includes('GROUP BY'));
  assert.ok(t.includes('[_d_currency]') && t.includes('[_d_unit]'));
});

test('inlineParams 把參數代成字面值（驗證用）', () => {
  const d = def({ columns: cols('customer'), mode: 'detail', filters: { logic: 'all', rows: [cond({ field: 'customer', op: 'in', values: ["O'Neil"] })] } });
  const s = inlineParams(buildDetail({ ...common(d), fields: ['customer'], limit: 5 }));
  assert.ok(s.includes("'O''Neil'") && !s.includes('@p0'));
});

test('enum 選項查詢：DISTINCT、ORDER BY、LIMIT 200', () => {
  const b = buildDistinct('orderLine', 'currency', 200, TODAY);
  assert.match(b.text, /^SELECT DISTINCT /);
  assert.match(b.text, /ORDER BY v LIMIT 200$/);
});

test('週粒度：分組鍵是該週週一，下鑽為 [週一, 下週一)', () => {
  const e = groupExpr('orderLine', { field: 'orderDate', gran: 'week' });
  assert.match(e, /strftime\('%w'/);
  const d = def({ columns: cols('orderNo', 'orderDate'), mode: 'detail' });
  const b = buildDetail({ ...common(d), fields: ['orderNo'], limit: 10, category: { group: { field: 'orderDate', gran: 'week' }, key: '2026-12-28' } });
  const vals = b.params.map((p) => p.value);
  assert.ok(vals.includes('2026-12-28') && vals.includes('2027-01-04'), JSON.stringify(vals));
  assert.ok(!b.text.includes('strftime'), '下鑽用原欄位比較區間，不套週運算式');
  const bad = buildDetail({ ...common(d), fields: ['orderNo'], limit: 10, category: { group: { field: 'orderDate', gran: 'week' }, key: 'x' } });
  assert.match(bad.text, /1 = 0/);
  assert.equal(allErrors(def({ columns: cols('orderDate'), groups: [{ field: 'orderDate', gran: 'week' }], metrics: [m('m1', 'count')] }), []).length, 0);
});

test('比率型彙總：SUM(分子)×scale÷NULLIF(SUM(分母),0)，引用的相關資料自動 JOIN；onTimeRate 是 ratio:onTime 的別名', () => {
  const d = def({ related: { delivery: true }, columns: cols('customer'), groups: [{ field: 'customer' }], metrics: [m('m1', 'ratio:onTime')] });
  const b = agg(d);
  assert.match(b.text, /NULLIF\(SUM\(r_onTime_d\), 0\)/);
  assert.match(b.text, /GROUP BY w2\.order_line_id/);
  assert.equal(allErrors(d, []).length, 0);
  const alias = agg(def({ related: { delivery: true }, columns: cols('customer'), groups: [{ field: 'customer' }], metrics: [m('m1', 'onTimeRate')] }));
  assert.equal(alias.text, b.text);
});

test('工令製程／工令零件主題：全部欄位可產生明細 SQL、完工看製程狀態、進度是自製製程完工比', async () => {
  const { CATALOG } = await import('../topics.ts');
  for (const topic of ['processLine', 'partProgress']) {
    const t = CATALOG[topic];
    assert.ok(t, topic);
    const related = Object.fromEntries(Object.keys(t.related).map((g) => [g, true]));
    const b = buildDetail({ topic, related, logic: 'all', conds: [], extra: [], today: TODAY, fields: t.fields.map((f) => f.id), limit: 10 });
    assert.ok(b.text.startsWith('SELECT '), topic);
  }
  const done = CATALOG.processLine.map.done.sql;
  assert.match(done, /p\.status = 'done'/);
  const d = def({ topic: 'partProgress', columns: cols('orderNo'), groups: [{ field: 'orderNo' }], metrics: [m('m1', 'ratio:orderProgress')] });
  assert.equal(allErrors(d, []).length, 0);
  const q = agg(d);
  assert.match(q.text, /ps\.selfDone/);
});

test('報工明細／機台日稼動主題：稼動依日曆與計入稼動的報工類別、比率 utilization', async () => {
  const { CATALOG } = await import('../topics.ts');
  for (const topic of ['workReport', 'machineDay']) {
    const t = CATALOG[topic];
    assert.ok(t, topic);
    const b = buildDetail({ topic, related: {}, logic: 'all', conds: [], extra: [], today: TODAY, fields: t.fields.map((f) => f.id), limit: 10 });
    assert.ok(b.text.startsWith('SELECT '), topic);
  }
  const wr = JSON.stringify(CATALOG.workReport);
  const md = CATALOG.machineDay.from + CATALOG.machineDay.where;
  assert.match(md, /work_calendar/); assert.match(md, /counts_as_run = 1/); assert.match(md, /retired_date IS NULL/); assert.match(md, /cal\.work_date <= @today/);
  const d = def({ topic: 'machineDay', columns: cols('machine'), groups: [{ field: 'machine' }], metrics: [m('m1', 'ratio:utilization')] });
  assert.equal(allErrors(d, []).length, 0);
  assert.match(agg(d).text, /NULLIF\(SUM\(r_utilization_d\), 0\)/);
  assert.equal(CATALOG.machineDay.ratios.utilization.note, '依報工機時計算，未扣休息時數');
});

test('採購明細／收料明細主題：SQL 過 guard、收料無金額欄、準時率分母只算已收齊', async () => {
  const { CATALOG } = await import('../topics.ts');
  for (const topic of ['purchaseLine', 'receiptLine']) {
    const t = CATALOG[topic];
    assert.ok(t, topic);
    const related = Object.fromEntries(Object.keys(t.related).map((g) => [g, true]));
    const b = buildDetail({ topic, related, logic: 'all', conds: [], extra: [], today: TODAY, fields: t.fields.map((f) => f.id), limit: 10 });
    assert.ok(b.text.startsWith('SELECT '), topic);
  }
  for (const f of CATALOG.receiptLine.fields) {
    assert.doesNotMatch(f.sql, /amount|price/, f.id);
    assert.ok(!['origMoney', 'localMoney', 'origPrice'].includes(f.kind), f.id);
  }
  const r = CATALOG.purchaseLine.ratios.supplierOnTime;
  assert.ok(r, 'supplierOnTime');
  assert.match(r.den, /recvQty/); assert.match(r.den, /d\.qty/);
  assert.equal(CATALOG.purchaseLine.map.category, undefined);
  const d = def({ topic: 'purchaseLine', related: { receipt: true }, columns: cols('supplier'), groups: [{ field: 'supplier' }], metrics: [m('m1', 'ratio:supplierOnTime')] });
  assert.equal(allErrors(d, []).length, 0);
  assert.match(agg(d).text, /NULLIF\(SUM\(r_supplierOnTime_d\), 0\)/);
});
