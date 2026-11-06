// 對真實 Demo 資料庫跑欄位目錄與 SQL 產生器，並和產生器獨立累計的數字對帳。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDemoDb } from '../db.ts';
import { DDL } from '../demo/schema.ts';
import { generateDemo } from '../demo/generate.ts';
import { buildAggregate, buildDetail, buildDistinct } from '../sqlgen.ts';
import type { Built } from '../sqlgen.ts';
import { CATALOG } from '../topics.ts';
import { cond, m, TODAY } from './helpers.ts';
import type { Metric } from '../engine.ts';

const demo = openDemoDb(join(mkdtempSync(join(tmpdir(), 'topics-')), 'demo.db'), TODAY);
after(() => demo.close());
const mem = new DatabaseSync(':memory:');
mem.exec(DDL);
const truth = generateDemo(mem, TODAY);

const allRelated = (topic: string): Record<string, boolean> => Object.fromEntries(Object.keys(CATALOG[topic].related).map((g) => [g, true]));
const common = (topic: string, conds: ReturnType<typeof cond>[] = []) => ({ topic, related: allRelated(topic), logic: 'all' as const, conds, extra: [], today: TODAY });
const run = (q: Built) => demo.exec(q);
const metric = (id: string, agg: string, field: string | null = null): Metric => m(id, agg, field) as unknown as Metric;
const num = (v: unknown): number => Number(v);

async function grouped(topic: string, field: string, agg = 'count', valueField: string | null = null): Promise<Record<string, number>> {
  const rows = await run(buildAggregate({ ...common(topic), groups: [{ field }], metrics: [metric('x', agg, valueField)], limit: 500 }));
  return Object.fromEntries(rows.filter((r) => r.g0 != null).map((r) => [String(r.g0), num(r.m_x)]));
}
async function total(topic: string, field: string): Promise<number> {
  const rows = await run(buildAggregate({ ...common(topic), groups: [], metrics: [metric('x', 'sum', field)] }));
  return num(rows[0].m_x);
}

test('每個主題的每個欄位都能查', async () => {
  for (const t of Object.values(CATALOG)) {
    for (const f of t.fields) {
      await run(buildDetail({ ...common(t.id), fields: [f.id], limit: 5 }));
      await run(buildDistinct(t.id, f.id, 5, TODAY));
    }
  }
});

test('每個比率都能算', async () => {
  for (const t of Object.values(CATALOG)) {
    for (const r of Object.values(t.ratios)) {
      const rows = await run(buildAggregate({ ...common(t.id), groups: [], metrics: [metric('x', 'ratio:' + r.id)] }));
      const v = rows[0].m_x as number | null;
      assert.ok(typeof v === 'number', t.id + '.' + r.id);
      assert.ok(v >= 0 && v <= (r.id === 'utilization' ? 150 : 100), t.id + '.' + r.id + ' = ' + v);
    }
  }
});

test('週分組起始都是週一', async () => {
  const rows = await run(buildAggregate({ ...common('orderLine'), groups: [{ field: 'orderDate', gran: 'week' }], metrics: [metric('x', 'count')], limit: 500 }));
  assert.ok(rows.length > 90);
  for (const r of rows) assert.equal(new Date(String(r.g0) + 'T00:00:00Z').getUTCDay(), 1, String(r.g0));
});

test('月分組是 YYYY-MM', async () => {
  const rows = await run(buildAggregate({ ...common('orderLine'), groups: [{ field: 'orderDate', gran: 'month' }], metrics: [metric('x', 'count')], limit: 500 }));
  assert.ok(rows.length >= 24);
  for (const r of rows) assert.match(String(r.g0), /^\d{4}-\d{2}$/);
});

test('文字條件含特殊字元不會變成 SQL', async () => {
  const conds = [cond({ field: 'partName', op: 'contains', value: "'; DROP TABLE customers --" })];
  assert.equal((await run(buildDetail({ ...common('orderLine', conds), fields: ['partName'], limit: 5 }))).length, 0);
  assert.ok(num((await run({ text: 'SELECT COUNT(*) AS n FROM customers', params: [] }))[0].n) > 0);
});

test('對帳：訂單交期狀態與客戶本幣金額', async () => {
  assert.deepEqual(await grouped('orderLine', 'dueStatus'), truth.dueStatusCounts);
  assert.deepEqual(await grouped('orderLine', 'customer', 'sum', 'amountLocal'), truth.amountLocalByCustomer);
});

test('對帳：機台機時、產能與稼動率', async () => {
  assert.ok(Math.abs((await total('machineDay', 'runHr')) - truth.runHours) < 0.01);
  assert.equal(await total('machineDay', 'capacityHr'), truth.capacityHours);
  const util = await grouped('machineDay', 'machine', 'ratio:utilization');
  for (const [no, v] of Object.entries(truth.machineUtilization)) assert.ok(Math.abs(util[no] - v) < 0.01, no);
});

test('對帳：供應商交期與準時率', async () => {
  assert.deepEqual(await grouped('purchaseLine', 'deliveryState'), truth.supplierDeliveryCounts);
  const rate = await grouped('purchaseLine', 'supplier', 'ratio:supplierOnTime');
  for (const [n, v] of Object.entries(truth.supplierOnTimeRate)) assert.ok(Math.abs(rate[n] - v) < 0.01, n);
});

test('對帳：積壓製程與久未動', async () => {
  assert.deepEqual(await grouped('processLine', 'backlogState'), truth.backlogCounts);
  const idle = cond({ field: 'idleDays', op: 'ge', value: '7' });
  const rows = await run(buildAggregate({ ...common('processLine', [idle]), groups: [], metrics: [metric('x', 'count')] }));
  assert.equal(num(rows[0].m_x), truth.idleProcesses);
});

test('全欄位最壞情況夠快', async () => {
  for (const t of Object.values(CATALOG)) {
    const t0 = performance.now();
    await run(buildDetail({ ...common(t.id), fields: t.fields.map((f) => f.id), limit: 2000 }));
    const ms = performance.now() - t0;
    assert.ok(ms < 1000, t.id + ' ' + ms + ' ms');
  }
});
