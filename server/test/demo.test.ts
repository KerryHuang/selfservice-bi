import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdtempSync, openSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DDL, SCHEMA_VERSION } from '../demo/schema.ts';
import { generateDemo } from '../demo/generate.ts';
import { openDemoDb } from '../db.ts';
import { SqlGuardError } from '../guard.ts';

const TODAY = '2026-11-06';
const TABLES = ['customers', 'suppliers', 'sales_orders', 'sales_order_lines', 'shipments', 'shipment_lines', 'job_parts', 'processes', 'machines', 'work_calendar', 'work_reports', 'purchase_orders', 'purchase_lines', 'receipts', 'receipt_lines'];

function fresh(today: string) {
  const db = new DatabaseSync(':memory:');
  db.exec(DDL);
  return { db, truth: generateDemo(db, today) };
}
const dbPath = (): string => join(mkdtempSync(join(tmpdir(), 'demo-')), 'demo.db');
const hash = (db: DatabaseSync): string => {
  const h = createHash('sha1');
  for (const t of TABLES) h.update(JSON.stringify(db.prepare('SELECT * FROM ' + t + ' ORDER BY 1').all()));
  return h.digest('hex');
};
const pct = (n: number, d: number): number => (d ? (n * 100) / d : 0);
const sumValues = (o: Record<string, number>): number => Object.values(o).reduce((a, b) => a + b, 0);

test('同一天產生的內容相同', () => {
  assert.equal(hash(fresh(TODAY).db), hash(fresh(TODAY).db));
});

// 每月 1 號與月底都要成立，避免故事只在某個日期才好看
for (const today of [TODAY, '2027-01-01', '2026-03-31']) {
  test('故事指標落在目標內：' + today, () => {
    const { truth: t } = fresh(today);
    const due = t.dueStatusCounts;
    const onTime = (due['如期'] || 0) + (due['提早'] || 0);
    const rate = pct(onTime, onTime + (due['延誤'] || 0) + (due['逾期未交'] || 0));
    assert.ok(rate >= 80 && rate <= 90, '達交率 ' + rate);
    const overdue = pct(due['逾期未交'] || 0, t.orderLines);
    assert.ok(overdue >= 1 && overdue <= 3, '逾期未交佔比 ' + overdue);

    const sup = t.supplierDeliveryCounts;
    const supRate = pct(sup['準時'] || 0, (sup['準時'] || 0) + (sup['延誤'] || 0));
    assert.ok(supRate >= 85 && supRate <= 95, '供應商準時率 ' + supRate);
    const rates = Object.values(t.supplierOnTimeRate).sort((a, b) => a - b);
    assert.ok(rates[1] < 78 && rates[2] >= 85, '應有 2 家供應商明顯偏低：' + rates.join(','));

    const util = pct(t.runHours, t.capacityHours);
    assert.ok(util >= 55 && util <= 85, '稼動率 ' + util);
    const machines = Object.values(t.machineUtilization).sort((a, b) => a - b);
    assert.ok(machines[0] < 40 && machines.at(-1)! > 90, '機台應有明顯偏閒與偏忙：' + machines[0] + ',' + machines.at(-1));

    for (const s of ['未開工', '準備開工', '開工中', '暫停']) assert.ok((t.backlogCounts[s] || 0) > 0, '積壓狀態缺 ' + s);
    assert.ok(t.idleProcesses >= 10, '久未動製程 ' + t.idleProcesses);
  });
}

test('資料涵蓋今天往前 24 個月，且最近一週有單', () => {
  const { db } = fresh(TODAY);
  const r = db.prepare('SELECT MIN(order_date) AS a, MAX(order_date) AS b FROM sales_orders').get() as { a: string; b: string };
  assert.ok(r.a <= '2024-11-10' && r.a >= '2024-11-01', r.a);
  assert.equal(r.b, TODAY);
  const w = db.prepare("SELECT COUNT(*) AS n FROM work_reports WHERE report_date > ?").get(TODAY) as { n: number };
  assert.equal(w.n, 0, '不應有未來的報工');
  const s = db.prepare("SELECT COUNT(*) AS n FROM shipments WHERE ship_date > ?").get(TODAY) as { n: number };
  assert.equal(s.n, 0, '不應有未來的出貨');
});

test('名稱都含示範', () => {
  const { db } = fresh(TODAY);
  for (const t of ['customers', 'suppliers']) {
    const rows = db.prepare('SELECT short_name AS n FROM ' + t).all() as { n: string }[];
    assert.ok(rows.length >= 12);
    assert.ok(rows.every((r) => r.n.includes('示範')), t);
    assert.equal(new Set(rows.map((r) => r.n)).size, rows.length, t + ' 名稱不可重複');
  }
});

test('日期欄一律是 YYYY-MM-DD 文字', () => {
  const { db } = fresh(TODAY);
  const cols: [string, string][] = [['sales_orders', 'order_date'], ['sales_order_lines', 'due_date'], ['shipments', 'ship_date'], ['processes', 'end_date'], ['work_reports', 'report_date'], ['purchase_lines', 'due_date'], ['receipts', 'receipt_date']];
  for (const [t, c] of cols) {
    const bad = db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${c} IS NOT NULL AND ${c} NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`).get() as { n: number };
    assert.equal(bad.n, 0, t + '.' + c);
  }
});

test('不存在時產生', () => {
  const d = openDemoDb(dbPath(), TODAY);
  assert.equal(d.regenerated, true);
  assert.equal(d.asOf, TODAY);
  d.close();
});

test('已存在時沿用並保留基準日', () => {
  const p = dbPath();
  openDemoDb(p, TODAY).close();
  const d = openDemoDb(p, '2026-12-25');
  assert.equal(d.regenerated, false);
  assert.equal(d.asOf, TODAY);
  d.close();
});

test('非資料庫檔會重建', async () => {
  const p = dbPath();
  writeFileSync(p, 'not a database');
  const d = openDemoDb(p, TODAY);
  assert.equal(d.regenerated, true);
  assert.ok((await d.exec({ text: 'SELECT COUNT(*) AS n FROM customers', params: [] }))[0].n as number > 0);
  d.close();
});

test('檔頭完好但資料頁損壞會重建', () => {
  const p = dbPath();
  openDemoDb(p, TODAY).close();
  assert.ok(statSync(p).size > 8 * 4096 + 65536);
  const fd = openSync(p, 'r+');
  writeSync(fd, Buffer.alloc(65536, 0xab), 0, 65536, 8 * 4096);
  closeSync(fd);
  const d = openDemoDb(p, TODAY);
  assert.equal(d.regenerated, true);
  d.close();
});

test('版本不符會重建', () => {
  const p = dbPath();
  openDemoDb(p, TODAY).close();
  const w = new DatabaseSync(p);
  w.prepare("UPDATE demo_meta SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION + 1));
  w.close();
  const d = openDemoDb(p, TODAY);
  assert.equal(d.regenerated, true);
  d.close();
});

test('中斷的暫存檔不影響', () => {
  const p = dbPath();
  writeFileSync(p + '.tmp', 'half written');
  const d = openDemoDb(p, TODAY);
  assert.equal(d.regenerated, true);
  assert.equal(existsSync(p + '.tmp'), false);
  d.close();
});

test('exec 過濾沒用到的參數', async () => {
  const d = openDemoDb(dbPath(), TODAY);
  const rows = await d.exec({ text: 'SELECT COUNT(*) AS n FROM customers', params: [{ name: 'today', type: 'date', value: TODAY }] });
  assert.ok((rows[0].n as number) > 0);
  const named = await d.exec({ text: 'SELECT @today AS t', params: [{ name: 'today', type: 'date', value: TODAY }] });
  assert.equal(named[0].t, TODAY);
  d.close();
});

test('exec 擋非 SELECT', async () => {
  const d = openDemoDb(dbPath(), TODAY);
  await assert.rejects(d.exec({ text: 'DELETE FROM customers', params: [] }), SqlGuardError);
  d.close();
});

test('訂單明細筆數與對帳基準一致', () => {
  const { db, truth } = fresh(TODAY);
  const n = db.prepare("SELECT COUNT(*) AS n FROM sales_order_lines l JOIN sales_orders o ON o.id = l.order_id WHERE o.status <> 'cancelled'").get() as { n: number };
  assert.equal(n.n, truth.orderLines);
  assert.equal(sumValues(truth.dueStatusCounts), truth.orderLines);
});
