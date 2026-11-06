// SQL 產生器：欄位運算式只取自 topics.json；運算子、彙總、粒度只取自程式內常數；使用者的值一律參數。
import { CATALOG, getField, isRatioAgg, ratioOf } from './topics.ts';
import type { Field, Topic } from './topics.ts';
import { assertSafeSelect } from './guard.ts';
import { addDays, fieldAvail, isIsoDate, needsRelated, resolveRange } from './engine.ts';
import type { Cond, Group, Metric } from './engine.ts';

export interface Param { name: string; type: 'date' | 'nvarchar' | 'float'; value: string | number }
export interface Built { text: string; params: Param[] }

export const BLANK = '（空白）';

class Ctx {
  params: Param[] = [];
  constructor(today: string) { this.params.push({ name: 'today', type: 'date', value: today }); }
  add(type: Param['type'], value: string | number): string { const name = 'p' + (this.params.length - 1); this.params.push({ name, type, value }); return '@' + name; }
}

function topicOf(id: string): Topic { const t = CATALOG[id]; if (!t) throw new Error('未知主題：' + id); return t; }
function fieldOf(topic: string, id: string): Field { const f = getField(topic, id); if (!f) throw new Error('欄位不在白名單：' + id); return f; }
const lit = (s: string): string => "'" + s.replace(/'/g, "''") + "'"; // 只用於程式內常數（狀態名稱）

export interface Common {
  topic: string; related: Record<string, boolean>; logic: 'all' | 'any'; conds: Cond[]; extra: Cond[]; today: string;
  /** 下鑽：點選的分類 */
  category?: { group: Group; key: string } | null;
}

/* ---------- 條件 ---------- */
function condSql(topic: string, c: Cond, ctx: Ctx): string {
  const f = fieldOf(topic, c.field), e = '(' + f.sql + ')';
  switch (f.type) {
    case 'text': {
      if (c.op === 'empty') return `(${e} IS NULL OR ${e} = '')`;
      if (c.op === 'notEmpty') return `(${e} IS NOT NULL AND ${e} <> '')`;
      const v = c.value.trim();
      if (c.op === 'eq') return `${e} = ${ctx.add('nvarchar', v)}`;
      if (c.op === 'contains') return `${e} LIKE ${ctx.add('nvarchar', '%' + v.replace(/[\\%_[]/g, '\\$&') + '%')} ESCAPE '\\'`;
      break;
    }
    case 'number': {
      const ops: Record<string, string> = { eq: '=', ne: '<>', gt: '>', ge: '>=', lt: '<', le: '<=' };
      if (c.op === 'between') return `(${e} >= ${ctx.add('float', parseFloat(c.value))} AND ${e} <= ${ctx.add('float', parseFloat(c.value2))})`;
      if (Object.hasOwn(ops, c.op)) return `${e} ${ops[c.op]} ${ctx.add('float', parseFloat(c.value))}`;
      break;
    }
    case 'date': {
      if (c.op === 'empty') return `${e} IS NULL`;
      const r = c.op === 'custom' ? { from: c.from, to: c.to } : resolveRange(c.op, undefined, undefined, ctx.params[0].value as string);
      if (!r) break;
      const parts = [`${e} IS NOT NULL`];
      if (r.from) parts.push(`${e} >= ${ctx.add('date', r.from)}`);
      if (r.to) parts.push(`${e} <= ${ctx.add('date', r.to)}`);
      return '(' + parts.join(' AND ') + ')';
    }
    case 'enum':
      if (c.op === 'in' && c.values.length) return `${e} IN (${c.values.map((v) => ctx.add('nvarchar', v)).join(', ')})`;
      break;
  }
  throw new Error('不支援的條件：' + f.type + '/' + c.op);
}

export function groupExpr(topic: string, g: Group): string {
  const f = fieldOf(topic, g.field);
  if (f.type === 'date') {
    if (g.gran === 'day') return `(${f.sql})`;
    // 週一起算（strftime %w：週日 0）
    if (g.gran === 'week') return `date((${f.sql}), '-' || ((CAST(strftime('%w', (${f.sql})) AS integer) + 6) % 7) || ' days')`;
    return `substr((${f.sql}), 1, 7)`; // 預設依月
  }
  return `NULLIF((${f.sql}), '')`; // 空字串與 NULL 併成同一組（顯示「（空白）」）
}

function categorySql(topic: string, cat: { group: Group; key: string }, ctx: Ctx): string {
  const f = fieldOf(topic, cat.group.field), e = groupExpr(topic, cat.group);
  if (cat.key === BLANK) return `${e} IS NULL`;
  if (f.type === 'date' && cat.group.gran === 'week') {
    if (!isIsoDate(cat.key)) return '1 = 0';
    const e2 = `(${f.sql})`;
    return `${e2} >= ${ctx.add('date', cat.key)} AND ${e2} < ${ctx.add('date', addDays(cat.key, 7))}`;
  }
  if (f.type === 'date' && cat.group.gran === 'day') return /^\d{4}-\d{2}-\d{2}$/.test(cat.key) ? `${e} = ${ctx.add('date', cat.key)}` : '1 = 0';
  return `${e} = ${ctx.add('nvarchar', cat.key)}`;
}

function usedFields(topic: string, fieldIds: Iterable<string>, c: Common): Set<string> {
  const s = new Set<string>(fieldIds);
  c.conds.forEach((x) => s.add(x.field)); c.extra.forEach((x) => s.add(x.field));
  if (c.category) s.add(c.category.group.field);
  return s;
}
function fromSql(t: Topic, used: Set<string>, related: Record<string, boolean>): string {
  const need = new Set<string>();
  for (const id of used) {
    const f = fieldOf(t.id, id);
    if (needsRelated(t.id, f)) {
      if (!fieldAvail({ topic: t.id, related }, f)) throw new Error('欄位需要相關資料：' + id);
      need.add(f.grp);
    }
  }
  return [t.from, ...Object.keys(t.related).filter((g) => need.has(g)).map((g) => t.related[g])].join(' ');
}
function whereSql(t: Topic, c: Common, ctx: Ctx): string {
  const parts = ['(' + t.where + ')'];
  if (c.conds.length) parts.push('(' + c.conds.map((x) => '(' + condSql(t.id, x, ctx) + ')').join(c.logic === 'any' ? ' OR ' : ' AND ') + ')');
  c.extra.forEach((x) => parts.push('(' + condSql(t.id, x, ctx) + ')'));
  if (c.category) parts.push('(' + categorySql(t.id, c.category, ctx) + ')');
  return parts.join(' AND ');
}

function finish(text: string, ctx: Ctx): Built {
  assertSafeSelect(text);
  return { text, params: ctx.params };
}

/* ---------- 明細 ---------- */
export interface DetailOpts extends Common { fields: string[]; limit: number; sort?: { key: string; dir: string } | null }
export function buildDetail(o: DetailOpts): Built {
  const t = topicOf(o.topic), ctx = new Ctx(o.today);
  const fields = [...new Set(o.fields)];
  const where = whereSql(t, o, ctx);
  const from = fromSql(t, usedFields(o.topic, fields, o), o.related);
  const sel = fields.map((id) => `(${fieldOf(o.topic, id).sql}) AS [${id}]`).join(', ');
  let order: string;
  if (o.sort && fields.includes(o.sort.key)) {
    const e = '(' + fieldOf(o.topic, o.sort.key).sql + ')';
    order = `CASE WHEN ${e} IS NULL THEN 1 ELSE 0 END, ${e} ${o.sort.dir === 'desc' ? 'DESC' : 'ASC'}`; // NULL 一律排最後
  } else order = '(' + fieldOf(o.topic, t.dateFields[0]).sql + ') ASC'; // 預設依第一個日期欄位（接單日／出貨日）
  return finish(`SELECT ${sel} FROM ${from} WHERE ${where} ORDER BY ${order} LIMIT ${Math.trunc(o.limit) + 1}`, ctx);
}

/* ---------- 彙總 ---------- */
export interface AggOpts extends Common { groups: Group[]; metrics: Metric[]; limit?: number; withDims?: boolean }

/** 各指標在「合計列」需要檢查的維度（原幣→幣別、數量→單位）。 */
export function dimOf(topic: string, m: Metric): 'currency' | 'unit' | null {
  const f = m.field ? getField(topic, m.field) : null;
  if (!f || !['sum', 'avg', 'max', 'min'].includes(m.agg)) return null;
  return f.kind === 'origMoney' || f.kind === 'origPrice' ? 'currency' : f.kind === 'qty' ? 'unit' : null;
}

export function metricSql(topic: string, m: Metric): string {
  const t = topicOf(topic);
  const key = (k: string): string => { if (!t.keys[k]) throw new Error('主題沒有鍵：' + k); return 'k_' + k; };
  const cnt = (cond: string): string => `SUM(CASE WHEN ${cond} THEN 1 ELSE 0 END)`;
  if (isRatioAgg(m.agg)) {
    const r = ratioOf(topic, m.agg);
    if (!r) throw new Error('彙總方式不在白名單：' + m.agg);
    // 依分組重算：分母為 0 回 NULL
    return `ROUND(CAST(SUM(r_${r.id}_n) AS float) * ${r.scale} / NULLIF(SUM(r_${r.id}_d), 0), 2)`;
  }
  switch (m.agg) {
    case 'count': return 'COUNT(*)';
    case 'distinctOrders': return `COUNT(DISTINCT ${key('orderNo')})`;
    case 'distinctLines': return `COUNT(DISTINCT ${key('lineKey')})`;
    case 'distinctShips': return `COUNT(DISTINCT ${key('shipNo')})`;
    case 'overdueCount': return `COALESCE(${cnt(`f_dueStatus = ${lit('逾期未交')}`)}, 0)`;
    case 'sum': return `COALESCE(SUM(f_${mField(topic, m)}), 0)`;
    case 'avg': return `AVG(CAST(f_${mField(topic, m)} AS float))`;
    case 'max': return `MAX(f_${mField(topic, m)})`;
    case 'min': return `MIN(f_${mField(topic, m)})`;
  }
  throw new Error('彙總方式不在白名單：' + m.agg);
}
function mField(topic: string, m: Metric): string { return fieldOf(topic, m.field || '').id; }

export function buildAggregate(o: AggOpts): Built {
  const t = topicOf(o.topic), ctx = new Ctx(o.today);
  const inner = new Map<string, string>(); // 別名 → 運算式
  const used = new Set<string>();
  const needField = (id: string): void => { const f = fieldOf(o.topic, id); used.add(id); inner.set('f_' + id, `(${f.sql})`); };
  o.groups.forEach((g, i) => { used.add(g.field); inner.set('g' + i, groupExpr(o.topic, g)); });
  const outerMetrics: string[] = [];
  for (const m of o.metrics) {
    if (!/^[A-Za-z0-9_]{1,32}$/.test(m.id)) throw new Error('指標 id 不合法');
    if (['sum', 'avg', 'max', 'min'].includes(m.agg)) needField(mField(o.topic, m));
    if (m.agg === 'overdueCount') needField('dueStatus');
    const r = isRatioAgg(m.agg) ? ratioOf(o.topic, m.agg) : null;
    if (r) { inner.set(`r_${r.id}_n`, `(${r.num})`); inner.set(`r_${r.id}_d`, `(${r.den})`); r.fields.forEach((f) => used.add(f)); }
    if (m.agg === 'distinctOrders') { inner.set('k_orderNo', `(${t.keys.orderNo})`); }
    if (m.agg === 'distinctLines') { inner.set('k_lineKey', `(${t.keys.lineKey})`); }
    if (m.agg === 'distinctShips') { inner.set('k_shipNo', `(${t.keys.shipNo})`); }
    outerMetrics.push(`${metricSql(o.topic, m)} AS [m_${m.id}]`);
  }
  if (o.withDims) {
    for (const d of new Set(o.metrics.map((m) => dimOf(o.topic, m)).filter((x): x is 'currency' | 'unit' => !!x))) {
      needField(d); outerMetrics.push(`COUNT(DISTINCT COALESCE(f_${d}, '')) AS [_d_${d}]`);
    }
  }
  if (!inner.size) inner.set('_one', '1');
  const where = whereSql(t, o, ctx);
  const from = fromSql(t, usedFields(o.topic, used, o), o.related);
  const innerSel = [...inner].map(([a, e]) => `${e} AS ${a}`).join(', ');
  const gcols = o.groups.map((_, i) => 'g' + i);
  const tail = gcols.length && o.limit ? ` LIMIT ${Math.trunc(o.limit) + 1}` : '';
  const sel = [...gcols, 'COUNT(*) AS _n', ...outerMetrics].join(', ');
  const text = `SELECT ${sel} FROM (SELECT ${innerSel} FROM ${from} WHERE ${where}) AS t${gcols.length ? ' GROUP BY ' + gcols.join(', ') : ''}${tail}`;
  return finish(text, ctx);
}

/* ---------- 列舉選項 ---------- */
export function buildDistinct(topic: string, fieldId: string, limit: number, today: string): Built {
  const t = topicOf(topic), f = fieldOf(topic, fieldId), ctx = new Ctx(today);
  const from = fromSql(t, new Set([fieldId]), { [f.grp]: true });
  return finish(`SELECT DISTINCT (${f.sql}) AS v FROM ${from} WHERE (${t.where}) AND (${f.sql}) IS NOT NULL ORDER BY v LIMIT ${Math.trunc(limit)}`, ctx);
}

/* ---------- 除錯／驗證用：把參數代成字面值（不會被送去執行） ---------- */
export function inlineParams(b: Built): string {
  const by = new Map(b.params.map((p) => [p.name, p]));
  return b.text.replace(/@(p\d+|today)\b/g, (_m, n: string) => {
    const p = by.get(n)!;
    if (p.type === 'float') return String(p.value);
    return "'" + String(p.value).replace(/'/g, "''") + "'";
  });
}
