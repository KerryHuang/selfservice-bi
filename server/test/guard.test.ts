import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertSafeFragment, assertSafeSelect } from '../guard.ts';
import { DEFAULT_TOPICS_PATH, parseTopics, CATALOG } from '../topics.ts';

test('SELECT 守衛：只放行單一 SELECT', () => {
  assertSafeSelect('SELECT a FROM t WHERE x = @p0');
  assertSafeSelect('  select a FROM sales_order_lines AS d LIMIT 3');
});

test('SELECT 守衛：非 SELECT 開頭被擋', () => {
  for (const s of ['DELETE FROM t', 'UPDATE t SET a = 1', 'EXEC sp_who', 'WITH x AS (SELECT 1) SELECT * FROM x', '  INSERT INTO t VALUES (1)'])
    assert.throws(() => assertSafeSelect(s), /./, s);
});

test('SELECT 守衛：分號、註解、危險字詞被擋', () => {
  const bad = [
    'SELECT 1; DROP TABLE x', 'SELECT 1 -- x', 'SELECT 1 /* x */', 'SELECT * FROM t WHERE a = 1 UNION SELECT 1 FROM OPENROWSET(1)',
    'SELECT 1 FROM t DELETE', 'SELECT xp_cmdshell', 'SELECT 1 FROM t WHERE 1=1 TRUNCATE', 'SELECT 1 GRANT', 'SELECT 1 shutdown', 'SELECT 1 FROM openquery(a,b)',
    'SELECT 1 dbcc', 'SELECT 1 merge', 'SELECT 1 backup', 'SELECT 1 deny'
  ];
  for (const s of bad) assert.throws(() => assertSafeSelect(s), /./, s);
});

test('SELECT 守衛：欄位名含關鍵字子字串不誤殺（created_at、update_note、exchange_rate）', () => {
  assertSafeSelect('SELECT u.created_at, h.update_note, h.exchange_rate FROM t');
  assertSafeFragment('COALESCE(d.item_no, 0)');
});

test('topics.json 每段 SQL 都通過片段檢查（載入成功即代表通過）', () => {
  assert.ok(Object.keys(CATALOG).length >= 2);
  for (const t of Object.values(CATALOG)) {
    assertSafeFragment(t.from); assertSafeFragment(t.where);
    for (const f of t.fields) assertSafeFragment(f.sql);
  }
});

test('topics.json 含危險片段 → 拒絕載入', () => {
  const raw = JSON.parse(readFileSync(DEFAULT_TOPICS_PATH, 'utf8'));
  const a = structuredClone(raw); a.topics.orderLine.fields[0].sql = "d.item_no; DROP TABLE x";
  assert.throws(() => parseTopics(a), /分號/);
  const b = structuredClone(raw); b.topics.shipment.where += ' AND 1 = (SELECT 1 FROM OPENQUERY(a, b))';
  assert.throws(() => parseTopics(b), /OPENQUERY/i);
  const c = structuredClone(raw); c.topics.orderLine.related.delivery = 'OUTER APPLY (DELETE FROM x) AS s';
  assert.throws(() => parseTopics(c), /DELETE/);
  const d = structuredClone(raw); d.topics.orderLine.fields[0].id = 'a b';
  assert.throws(() => parseTopics(d), /id 不合法/);
});
