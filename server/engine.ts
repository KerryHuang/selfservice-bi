// 引擎的「規則」部分（不碰資料）：日期區間、條件／定義驗證、Dashboard 篩選、widget 狀態、標籤格式。
// 需要資料的部分在 service.ts／sqlgen.ts。
import { CATALOG, getField, isRatioAgg, ratioOf } from './topics.ts';
import type { Field } from './topics.ts';

/* ---------- 型別 ---------- */
export interface Cond { id: string; field: string; op: string; value: string; value2: string; values: string[]; from: string; to: string }
export interface Group { field: string; gran?: string }
export interface Metric { id: string; agg: string; field: string | null; label: string }
export interface Def {
  topic: string; related: Record<string, boolean>; columns: { field: string; label: string }[];
  filters: { logic: 'all' | 'any'; rows: Cond[] }; mode: string; groups: Group[]; metrics: Metric[];
}
export interface Widget {
  id: string; title: string; type: string; size: string; reportId: string; topic: string;
  category: { field: string; gran: string } | null; metric: { agg: string; field: string | null; label: string } | null;
  dateField: string | null; metricName: string; unit: string | null; options?: WidgetOptions;
}
export interface WidgetOptions {
  sort?: 'desc' | 'asc'; limit?: number; cumulative?: boolean; compare?: { periods: number; gran: 'week' | 'month' };
  linkDashboardId?: string; range?: string;
}
export interface DashFilters { range: string; from: string; to: string; customers: string[]; orderTypes: string[] }
export interface Err { code: string; msg: string; step?: number; [k: string]: unknown }

/* ---------- 常數（白名單） ---------- */
export const STATUSES = ['未到期', '如期', '提早', '延誤', '逾期未交'];
export const RANGE_LABELS: Record<string, string> = { thisWeek: '本週', lastWeek: '上週', last8w: '近 8 週', thisMonth: '本月', lastMonth: '上月', last3m: '近 3 個月', last12m: '近 12 個月', thisYear: '今年', custom: '自訂區間', all: '不限' };
export const OPS: Record<string, [string, string][]> = {
  text: [['contains', '包含'], ['eq', '等於'], ['empty', '是空的'], ['notEmpty', '不是空的']],
  number: [['eq', '='], ['ne', '≠'], ['gt', '>'], ['ge', '≥'], ['lt', '<'], ['le', '≤'], ['between', '介於']],
  date: [['thisWeek', '本週'], ['lastWeek', '上週'], ['last8w', '近 8 週'], ['thisMonth', '本月'], ['lastMonth', '上月'], ['last3m', '近 3 個月'], ['thisYear', '今年'], ['custom', '自訂區間'], ['empty', '是空的']],
  enum: [['in', '屬於（可複選）']]
};
export const AGG_LABELS: Record<string, string> = {
  count: '資料列筆數', distinctOrders: '不重複訂單數', distinctLines: '不重複明細數', distinctShips: '不重複出貨單數',
  sum: '加總', avg: '平均', max: '最大', min: '最小', onTimeRate: '達交率', overdueCount: '逾期未交明細數'
};
export const VALUE_AGGS = ['sum', 'avg', 'max', 'min'];
export const LIMITS = { columns: 60, conds: 30, inValues: 200, metrics: 20, str: 200 };
const WIDGET_TYPES = ['metric', 'bar', 'line', 'pie', 'table'];
const RANGE_KEYS = ['all', 'thisWeek', 'lastWeek', 'last8w', 'thisMonth', 'lastMonth', 'last3m', 'last12m', 'thisYear', 'custom'];

/* ---------- 日期工具（UTC 計算） ---------- */
function pad(n: number): string { return (n < 10 ? '0' : '') + n; }
function parseD(s: string): Date { const p = s.split('-'); return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])); }
function fmtD(d: Date): string { return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); }
export function addDays(s: string, n: number): string { const d = parseD(s); d.setUTCDate(d.getUTCDate() + n); return fmtD(d); }
export function addMonths(s: string, n: number): string {
  const d = parseD(s), day = d.getUTCDate();
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n);
  const dim = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, dim)); return fmtD(d);
}
function monthEnd(s: string): string { const d = parseD(s); return fmtD(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0))); }
export function monthStart(s: string): string { return s.slice(0, 8) + '01'; }
export function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = parseD(s); return !isNaN(d.getTime()) && fmtD(d) === s;
}
/** 該日所屬週的週一（週一起算）。 */
export function weekStart(s: string): string { const d = parseD(s); return addDays(s, -((d.getUTCDay() + 6) % 7)); }
export function localToday(): string { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }

export function resolveRange(key: string, from: string | undefined, to: string | undefined, today: string): { from: string; to: string } | null {
  switch (key) {
    case 'thisWeek': return { from: weekStart(today), to: today };
    case 'lastWeek': { const w = addDays(weekStart(today), -7); return { from: w, to: addDays(w, 6) }; }
    case 'last8w': return { from: addDays(weekStart(today), -49), to: today };
    case 'thisMonth': return { from: monthStart(today), to: monthEnd(today) };
    case 'lastMonth': { const lm = addMonths(monthStart(today), -1); return { from: lm, to: monthEnd(lm) }; }
    case 'last3m': return { from: addDays(addMonths(today, -3), 1), to: today };
    case 'last12m': return { from: addDays(addMonths(today, -12), 1), to: today };
    case 'thisYear': return { from: today.slice(0, 4) + '-01-01', to: today.slice(0, 4) + '-12-31' };
    case 'custom': return { from: from || '', to: to || '' };
    default: return null;
  }
}
export function opLabel(type: string, op: string): string { const l = OPS[type] || []; for (const [k, v] of l) if (k === op) return v; return op; }

/* ---------- 請求內容正規化（不信任輸入：型別、長度、數量） ---------- */
export class BadRequest extends Error {}
function str(x: unknown, what: string): string {
  if (x == null) return '';
  if (typeof x !== 'string' && typeof x !== 'number') throw new BadRequest(what + ' 必須是文字');
  const s = String(x);
  if (s.length > LIMITS.str) throw new BadRequest(what + ' 過長（上限 ' + LIMITS.str + ' 字）');
  return s;
}
/** 結構欄位（id、欄位代碼、運算子…）只收代碼字元：這些值會進前端的 HTML 屬性。 */
function tok(x: unknown, what: string): string {
  const s = str(x, what);
  if (!/^[A-Za-z0-9_:-]*$/.test(s)) throw new BadRequest(what + ' 含不合法字元');
  return s;
}
function arr(x: unknown, what: string, max: number): unknown[] {
  if (x == null) return [];
  if (!Array.isArray(x)) throw new BadRequest(what + ' 必須是陣列');
  if (x.length > max) throw new BadRequest(what + ' 過多（上限 ' + max + '）');
  return x;
}
function obj(x: unknown, what: string): Record<string, unknown> {
  if (x == null || typeof x !== 'object' || Array.isArray(x)) throw new BadRequest(what + ' 必須是物件');
  return x as Record<string, unknown>;
}
export function normCond(x: unknown): Cond {
  const c = obj(x, '條件');
  return {
    id: tok(c.id, '條件 id'), field: tok(c.field, '條件欄位'), op: tok(c.op, '條件運算子'), value: str(c.value, '條件值'), value2: str(c.value2, '條件值'),
    values: arr(c.values, '條件 values', LIMITS.inValues).map((v) => str(v, '條件 values 項')), from: tok(c.from, '起日'), to: tok(c.to, '迄日')
  };
}
export function normConds(x: unknown): Cond[] { return arr(x, '條件', LIMITS.conds).map(normCond); }
export function normDef(x: unknown): Def {
  const d = obj(x, '報表定義'), f = d.filters == null ? {} : obj(d.filters, 'filters'), rel = d.related == null ? {} : obj(d.related, 'related');
  const related: Record<string, boolean> = {};
  for (const k of Object.keys(rel)) related[k] = rel[k] === true;
  return {
    topic: tok(d.topic, 'topic'), related,
    columns: arr(d.columns, 'columns', LIMITS.columns).map((c) => { const o = obj(c, '欄位'); return { field: tok(o.field, '欄位 id'), label: str(o.label, '欄位標題') }; }),
    filters: { logic: f.logic === 'any' ? 'any' : 'all', rows: normConds(f.rows) },
    mode: tok(d.mode, 'mode'),
    groups: arr(d.groups, 'groups', 10).map((g) => { const o = obj(g, '分組'); return { field: tok(o.field, '分組欄位'), gran: o.gran == null ? undefined : tok(o.gran, 'gran') }; }),
    metrics: arr(d.metrics, 'metrics', LIMITS.metrics).map((m) => {
      const o = obj(m, '指標');
      return { id: tok(o.id, '指標 id'), agg: tok(o.agg, '指標彙總'), field: o.field ? tok(o.field, '指標欄位') : null, label: str(o.label, '指標標題') };
    })
  };
}
export function normWidget(x: unknown): Widget {
  const w = obj(x, 'widget');
  const type = str(w.type, 'widget.type');
  if (!WIDGET_TYPES.includes(type)) throw new BadRequest('widget.type 不合法：' + type);
  const cat = w.category == null ? null : obj(w.category, 'widget.category');
  const met = w.metric == null ? null : obj(w.metric, 'widget.metric');
  const size = str(w.size, 'widget.size');
  if (!['', 'S', 'M', 'L'].includes(size)) throw new BadRequest('widget.size 只能是 S、M、L');
  return {
    id: tok(w.id, 'widget.id'), title: str(w.title, 'widget.title'), type, size, reportId: tok(w.reportId, 'widget.reportId'),
    topic: tok(w.topic, 'widget.topic'), category: cat ? { field: tok(cat.field, '分類欄位'), gran: cat.gran ? tok(cat.gran, 'gran') : 'month' } : null,
    metric: met ? { agg: tok(met.agg, '指標彙總'), field: met.field ? tok(met.field, '指標欄位') : null, label: str(met.label, '指標標題') } : null,
    dateField: w.dateField ? tok(w.dateField, 'widget.dateField') : null, metricName: str(w.metricName, 'widget.metricName'),
    unit: w.unit == null ? null : str(w.unit, 'widget.unit'),
    ...(w.options == null ? {} : { options: normOptions(w.options) })
  };
}
const OPT_RANGES = ['thisWeek', 'lastWeek', 'last8w', 'thisMonth', 'lastMonth', 'last3m', 'last12m', 'thisYear'];
function intIn(x: unknown, lo: number, hi: number, what: string): number {
  if (typeof x !== 'number' || !Number.isInteger(x) || x < lo || x > hi) throw new BadRequest('widget.options.' + what + ' 必須是 ' + lo + '～' + hi + ' 的整數');
  return x;
}
function normOptions(x: unknown): WidgetOptions | undefined {
  if (x == null) return undefined;
  const o = obj(x, 'widget.options'), out: WidgetOptions = {};
  if (o.sort != null) { if (o.sort !== 'desc' && o.sort !== 'asc') throw new BadRequest('widget.options.sort 只能是 desc 或 asc'); out.sort = o.sort; }
  if (o.limit != null) out.limit = intIn(o.limit, 1, 50, 'limit');
  if (o.cumulative != null) out.cumulative = o.cumulative === true;
  if (o.compare != null) {
    const c = obj(o.compare, 'widget.options.compare');
    if (c.gran !== 'week' && c.gran !== 'month') throw new BadRequest('widget.options.compare.gran 只能是 week 或 month');
    out.compare = { periods: intIn(c.periods, 1, 12, 'compare.periods'), gran: c.gran };
  }
  if (o.linkDashboardId != null) out.linkDashboardId = tok(o.linkDashboardId, 'widget.options.linkDashboardId');
  if (o.range != null) { if (!OPT_RANGES.includes(o.range as string)) throw new BadRequest('widget.options.range 不合法：' + String(o.range)); out.range = o.range as string; }
  return out;
}
export function normDash(x: unknown): { filters: DashFilters } {
  const d = x == null ? {} : obj(x, 'dash'), f = d.filters == null ? {} : obj(d.filters, 'dash.filters');
  const range = f.range == null ? 'all' : str(f.range, 'range');
  if (!RANGE_KEYS.includes(range)) throw new BadRequest('dash.filters.range 不合法：' + range);
  return {
    filters: {
      range, from: tok(f.from, 'from'), to: tok(f.to, 'to'),
      customers: arr(f.customers, 'customers', LIMITS.inValues).map((v) => str(v, 'customers 項')),
      orderTypes: arr(f.orderTypes, 'orderTypes', LIMITS.inValues).map((v) => str(v, 'orderTypes 項'))
    }
  };
}

/* ---------- 欄位可用性 ---------- */
/** 欄位所屬群組在 topic.related 有定義者，需要報表勾選該相關資料才可用。 */
export function needsRelated(topic: string, f: Field): boolean { return f.grp in (CATALOG[topic]?.related || {}); }
export function fieldAvail(def: Pick<Def, 'topic' | 'related'>, f: Field): boolean { return !needsRelated(def.topic, f) || !!(def.related && def.related[f.grp]); }
export function fieldLabel(topic: string, id: string | null | undefined): string { const f = id ? getField(topic, id) : null; return f ? f.label : (id || ''); }

/* ---------- 條件驗證 ---------- */
function checkCond(def: Pick<Def, 'topic' | 'related'>, c: Cond): string | null {
  const f = getField(def.topic, c.field);
  if (!f || !fieldAvail(def, f)) return '欄位「' + (f ? f.label : c.field) + '」目前不可用（請確認相關資料已加入）';
  if (!(OPS[f.type] || []).some((o) => o[0] === c.op)) return '運算子「' + c.op + '」不適用於「' + f.label + '」';
  if (f.type === 'text') { if ((c.op === 'contains' || c.op === 'eq') && !String(c.value || '').trim()) return '請輸入要比對的文字'; }
  else if (f.type === 'number') {
    const v = parseFloat(c.value);
    if (c.value === '' || !isFinite(v)) return '請輸入數值';
    if (c.op === 'between') {
      const v2 = parseFloat(c.value2);
      if (c.value2 === '' || !isFinite(v2)) return '「介於」需要填起、迄兩個數值';
      if (v > v2) return '起值不可大於迄值';
    }
  } else if (f.type === 'date') {
    if (c.op === 'custom') {
      if (!c.from || !c.to) return '自訂區間需要填起、迄日期';
      if (!isIsoDate(c.from) || !isIsoDate(c.to)) return '日期格式必須是 YYYY-MM-DD';
      if (c.from > c.to) return '起日不可晚於迄日';
    }
  } else if (f.type === 'enum') { if (!c.values || !c.values.length) return '請至少勾選一個項目'; }
  return null;
}
export function validateConditions(def: Def): Err[] {
  const errs: Err[] = [];
  def.filters.rows.forEach((c, idx) => {
    const m = checkCond(def, c);
    if (m) errs.push({ code: 'COND_INCOMPLETE', condId: c.id, index: idx, short: m, step: 3, msg: '第 ' + (idx + 1) + ' 個條件：' + m });
  });
  return errs;
}
/** Dashboard 共用篩選轉出的條件（extra）：同一套規則；外部傳入的 extra 也要驗。 */
export function validateExtra(def: Def, extra: Cond[]): Err[] {
  const errs: Err[] = [];
  extra.forEach((c, idx) => {
    const m = checkCond(def, c);
    if (m) errs.push({ code: 'COND_INCOMPLETE', index: idx, short: m, msg: 'Dashboard 篩選第 ' + (idx + 1) + ' 項：' + m });
  });
  return errs;
}

/* ---------- 標籤／格式 ---------- */
export function aggLabel(topic: string, agg: string): string {
  if (isRatioAgg(agg)) return ratioOf(topic, agg)?.label || agg;
  return agg === 'count' ? CATALOG[topic].countLabel : AGG_LABELS[agg];
}
export function metricDefaultLabel(topic: string, m: { agg: string; field: string | null }): string {
  const f = m.field ? getField(topic, m.field) : null;
  if (m.agg === 'sum') return (f ? f.label : '') + '合計';
  if (m.agg === 'avg') return '平均' + (f ? f.label : '');
  if (m.agg === 'max') return '最大' + (f ? f.label : '');
  if (m.agg === 'min') return '最小' + (f ? f.label : '');
  return aggLabel(topic, m.agg);
}
export function metricLabel(topic: string, m: { agg: string; field: string | null; label?: string }): string { return m.label || metricDefaultLabel(topic, m); }
export function metricFmt(topic: string, m: { agg: string; field: string | null }): string {
  if (isRatioAgg(m.agg)) return 'rate';
  if (m.agg === 'avg') { const f = m.field ? getField(topic, m.field) : null; return f && f.fmt === 'int' ? 'num' : 'money2'; }
  const f2 = m.field ? getField(topic, m.field) : null;
  if (f2) return f2.fmt === 'money' ? 'money' : f2.fmt === 'int' ? 'int' : f2.fmt;
  return 'int';
}
export function metricUnit(topic: string, m: { agg: string; field: string | null }): string {
  if (isRatioAgg(m.agg)) return ratioOf(topic, m.agg)?.unit ?? '%';
  if (m.agg === 'distinctOrders' || m.agg === 'distinctShips') return '張';
  if (m.agg === 'count' || m.agg === 'distinctLines' || m.agg === 'overdueCount') return '筆';
  const f = m.field ? getField(topic, m.field) : null;
  if (!f) return '';
  if (f.kind === 'localMoney') return '本幣';
  if (f.kind === 'origMoney' || f.kind === 'origPrice') return '原幣';
  if (f.kind === 'qty') return '數量';
  return '';
}
export function round2(x: number): number { return Math.round(x * 100) / 100; }

/* ---------- 定義驗證 ---------- */
export function singleOf(def: Def, extra: Cond[], field: string): boolean {
  if (def.groups.some((g) => g.field === field)) return true;
  const conds = (def.filters.logic !== 'any' ? def.filters.rows : []).concat(extra || []);
  return conds.some((c) => c.field === field && c.op === 'in' && (c.values || []).length === 1);
}
const NEEDS_DELIVERY_AGGS = ['overdueCount'];
/** 比率引用的欄位所屬相關資料群組沒勾時，回傳第一個缺的群組 id。 */
export function ratioMissingGroup(def: Pick<Def, 'topic' | 'related'>, agg: string): string | null {
  const r = ratioOf(def.topic, agg); if (!r) return null;
  for (const id of r.fields) { const f = getField(def.topic, id)!; if (!fieldAvail(def, f)) return f.grp; }
  return null;
}
export function validateDef(def: Def, extra: Cond[]): Err[] {
  const errs: Err[] = [], topic = def.topic;
  if (!CATALOG[topic]) return [{ code: 'NO_TOPIC', msg: '請先選擇資料主題' }];
  const cols = def.columns.map((c) => c.field);
  // 欄位必須存在於白名單；需要相關資料的群組（交期結果）要先勾選
  const seen = new Set<string>();
  cols.forEach((id) => {
    const f = getField(topic, id);
    if (!f) errs.push({ code: 'FIELD_UNKNOWN', msg: '欄位「' + id + '」不存在於「' + CATALOG[topic].label + '」主題', step: 2 });
    else if (!fieldAvail(def, f) && !seen.has(f.grp)) {
      seen.add(f.grp);
      errs.push({ code: 'NEEDS_DELIVERY', msg: '欄位「' + f.label + '」需要先加入相關資料「' + (CATALOG[topic].groups[f.grp] || f.grp) + '」', step: 1, field: id });
    }
  });
  if (errs.length) return errs;
  if (def.mode !== 'summary') {
    if (!cols.length) errs.push({ code: 'NO_COLUMNS', msg: '還沒有選任何欄位，請先到「選擇欄位」加入至少一個欄位', step: 2 });
    return errs;
  }
  const { groups, metrics } = def;
  if (groups.length > 2) errs.push({ code: 'GROUP_LIMIT', msg: '分組欄位最多 2 個', step: 4 });
  groups.forEach((g) => {
    const f = getField(topic, g.field);
    if (!f || cols.indexOf(g.field) < 0) errs.push({ code: 'FIELD_MISSING', msg: '分組欄位「' + (f ? f.label : g.field) + '」不在已選欄位中', step: 2 });
    else if (f.type === 'number') errs.push({ code: 'GROUP_TYPE', msg: '數值欄位「' + f.label + '」不能當分組', step: 4 });
    else if (f.type === 'date' && g.gran != null && !['day', 'week', 'month'].includes(g.gran)) errs.push({ code: 'BAD_GRAN', msg: '日期分組粒度只能是 day、week 或 month', step: 4 });
  });
  if (!metrics.length) errs.push({ code: 'NO_METRIC', msg: '彙總表至少要有一個指標', step: 4 });
  const ids = new Set<string>();
  metrics.forEach((m) => {
    if (!/^[A-Za-z0-9_]{1,32}$/.test(m.id) || ids.has(m.id)) { errs.push({ code: 'BAD_METRIC_ID', msg: '指標 id 必須是 1～32 碼英數底線且不可重複', step: 4, metricId: m.id }); return; }
    ids.add(m.id);
    if (isRatioAgg(m.agg)) {
      if (!ratioOf(topic, m.agg)) { errs.push({ code: 'BAD_AGG', msg: '不支援的彙總方式：' + m.agg, step: 4, metricId: m.id }); return; }
      const g = ratioMissingGroup(def, m.agg);
      if (g) errs.push({ code: 'NEEDS_RELATED', msg: '「' + metricLabel(topic, m) + '」需要先加入相關資料「' + (CATALOG[topic].groups[g] || g) + '」', step: 1, metricId: m.id });
      return;
    }
    if (!Object.hasOwn(AGG_LABELS, m.agg)) { errs.push({ code: 'BAD_AGG', msg: '不支援的彙總方式：' + m.agg, step: 4, metricId: m.id }); return; }
    const nm = metricLabel(topic, m), f = m.field ? getField(topic, m.field) : null;
    if (VALUE_AGGS.indexOf(m.agg) >= 0) {
      if (!f) { errs.push({ code: 'FIELD_MISSING', msg: '指標「' + nm + '」還沒選欄位', step: 4, metricId: m.id }); return; }
      if (cols.indexOf(f.id) < 0) { errs.push({ code: 'FIELD_MISSING', msg: '指標欄位「' + f.label + '」不在已選欄位中', step: 2, metricId: m.id }); return; }
      if (f.notSummable) { errs.push({ code: 'NOT_SUMMABLE', msg: '「' + f.label + '」不可做' + AGG_LABELS[m.agg] + '：' + f.notSummable, step: 4, metricId: m.id, field: f.id }); return; }
      if (f.type !== 'number') { errs.push({ code: 'AGG_TYPE', msg: '「' + f.label + '」不是數值欄位，不能做' + AGG_LABELS[m.agg], step: 4, metricId: m.id, field: f.id }); return; }
      if (f.kind === 'origMoney' || f.kind === 'origPrice') {
        if (!singleOf(def, extra, 'currency')) errs.push({ code: 'MIXED_CURRENCY', msg: '「' + f.label + '」的資料混有不同幣別，不能直接' + AGG_LABELS[m.agg] + '。', step: 4, metricId: m.id, field: f.id,
          fixes: [{ type: 'addGroup', field: 'currency', text: '加入「幣別」分組' }, { type: 'filterCurrency', text: '條件篩成單一幣別' }] });
      }
      if (f.kind === 'qty') {
        if (!singleOf(def, extra, 'unit')) errs.push({ code: 'MIXED_UNIT', msg: '「' + f.label + '」的資料混有不同單位，不能直接' + AGG_LABELS[m.agg] + '。', step: 4, metricId: m.id, field: f.id,
          fixes: [{ type: 'addGroup', field: 'unit', text: '加入「單位」分組' }, { type: 'filterUnit', text: '條件篩成單一單位' }] });
      }
    } else if (NEEDS_DELIVERY_AGGS.indexOf(m.agg) >= 0) {
      if (topic !== 'orderLine' || !(def.related && def.related.delivery)) errs.push({ code: 'NEEDS_DELIVERY', msg: '「' + nm + '」需要「訂單明細」主題並加入「交期結果」', step: 1, metricId: m.id });
    } else if (m.agg === 'distinctShips' && topic !== 'shipment') errs.push({ code: 'AGG_TOPIC', msg: '「不重複出貨單數」只適用出貨明細主題', step: 4, metricId: m.id });
  });
  return errs;
}
export function allErrors(def: Def, extra: Cond[]): Err[] {
  if (!CATALOG[def.topic]) return [{ code: 'NO_TOPIC', msg: '請先選擇資料主題' }];
  const e = validateConditions(def); if (e.length) return e;
  const e2 = validateExtra(def, extra); if (e2.length) return e2;
  return validateDef(def, extra);
}

/* ---------- Dashboard 篩選 → extra 條件 ---------- */
export function buildExtra(widget: Widget, report: Def, dash: { filters: DashFilters } | null, today: string) {
  const f = (dash && dash.filters) || { range: 'all', from: '', to: '', customers: [], orderTypes: [] }, topic = report.topic;
  const conds: Cond[] = [], applied: string[] = [], notApplied: string[] = [];
  const mk = (field: string, op: string, o: Partial<Cond>): Cond => ({ id: '', field, op, value: '', value2: '', values: [], from: '', to: '', ...o });
  const own = widget.options?.range; // 卡片自己的期間優先於儀表板篩選
  const range = own || f.range || 'all', r = resolveRange(range, own ? '' : f.from, own ? '' : f.to, today);
  const df = widget.dateField ? getField(topic, widget.dateField) : null;
  if (r) {
    if (df && fieldAvail(report, df)) {
      conds.push(mk(df.id, 'custom', { from: r.from, to: r.to }));
      applied.push('日期：' + RANGE_LABELS[range] + '（' + r.from + ' ～ ' + r.to + '）' + (own ? '（卡片設定）' : ''));
    } else notApplied.push('日期');
  }
  if (f.customers && f.customers.length) {
    if (getField(topic, 'customer')) { conds.push(mk('customer', 'in', { values: f.customers.slice() })); applied.push('客戶：' + f.customers.join('、')); }
    else notApplied.push('客戶');
  }
  if (f.orderTypes && f.orderTypes.length) {
    if (getField(topic, 'orderType')) { conds.push(mk('orderType', 'in', { values: f.orderTypes.slice() })); applied.push('訂單類型：' + f.orderTypes.join('、')); }
    else notApplied.push('訂單類型');
  }
  return { conds, applied, notApplied, dateFieldLabel: widget.dateField ? fieldLabel(topic, widget.dateField) : null };
}

/* ---------- 描述 ---------- */
export function describeCond(topic: string, c: Cond, today: string): string {
  const f = getField(topic, c.field); if (!f) return c.field;
  const n = f.label;
  if (f.type === 'enum') return n + ' 屬於 ' + (c.values || []).join('、');
  if (f.type === 'date') {
    if (c.op === 'custom') return n + ' ' + (c.from || '?') + ' ～ ' + (c.to || '?');
    if (c.op === 'empty') return n + ' 是空的';
    const r = resolveRange(c.op, undefined, undefined, today)!; return n + ' ' + opLabel('date', c.op) + '（' + r.from + ' ～ ' + r.to + '）';
  }
  if (f.type === 'number') return n + ' ' + opLabel('number', c.op) + ' ' + c.value + (c.op === 'between' ? ' ～ ' + c.value2 : '');
  if (c.op === 'empty' || c.op === 'notEmpty') return n + ' ' + opLabel('text', c.op);
  return n + ' ' + opLabel('text', c.op) + ' 「' + c.value + '」';
}
export function describeDef(def: Def, today: string): string[] {
  const rows = def.filters.rows, t = rows.map((c) => describeCond(def.topic, c, today));
  return rows.length ? [(def.filters.logic === 'any' ? '符合以下任一條件：' : '符合以下全部條件：') + t.join('；')] : ['報表本身沒有設條件（全部資料）'];
}

/* ---------- widget ---------- */
export function widgetStatus(w: Widget, report: Def | null): { ok: boolean; code?: string; reason?: string } {
  if (!report) return { ok: false, code: 'REPORT_MISSING', reason: '來源報表已被刪除，或不再分享給你。' };
  if (w.topic && report.topic !== w.topic) return { ok: false, code: 'TOPIC_CHANGED', reason: '來源報表的資料主題已改變，這張圖原本的欄位對不上。' };
  if (w.type === 'table') return { ok: true };
  const cols = report.columns.map((c) => c.field);
  if (w.type !== 'metric' && (!w.category || cols.indexOf(w.category.field) < 0))
    return { ok: false, code: 'FIELD_REMOVED', reason: '分類欄位「' + fieldLabel(report.topic, w.category && w.category.field) + '」已從來源報表移除。' };
  if (w.metric && w.metric.field && cols.indexOf(w.metric.field) < 0)
    return { ok: false, code: 'FIELD_REMOVED', reason: '數值欄位「' + fieldLabel(report.topic, w.metric.field) + '」已從來源報表移除。' };
  if (w.metric && isRatioAgg(w.metric.agg) && ratioMissingGroup(report, w.metric.agg))
    return { ok: false, code: 'FIELD_REMOVED', reason: '來源報表已不含計算「' + metricLabel(report.topic, w.metric) + '」所需的相關資料。' };
  if (w.metric && NEEDS_DELIVERY_AGGS.indexOf(w.metric.agg) >= 0 && !(report.related && report.related.delivery))
    return { ok: false, code: 'FIELD_REMOVED', reason: '來源報表已不含「交期結果」，無法計算「' + metricLabel(report.topic, w.metric) + '」。' };
  return { ok: true };
}
export function synthDef(report: Def, w: { type: string; category: { field: string; gran?: string } | null; metric: { agg: string; field: string | null; label?: string } }): Def {
  return {
    topic: report.topic, related: report.related, columns: report.columns, filters: report.filters, mode: 'summary',
    groups: w.type === 'metric' || !w.category ? [] : [{ field: w.category.field, gran: w.category.gran || 'month' }],
    metrics: [{ id: 'w', agg: w.metric.agg, field: w.metric.field || null, label: w.metric.label || '' }]
  };
}
/** 可加總（可算累計占比、缺期補 0）的彙總方式。 */
export const SUMMABLE_AGGS = ['count', 'sum', 'distinctOrders', 'distinctLines', 'distinctShips', 'overdueCount'];
export function pieCheck(agg: string, pts: { value: number | null }[]): string | null {
  if (isRatioAgg(agg) || ['avg', 'max', 'min'].indexOf(agg) >= 0) return '圓餅圖只能用「可加總」的指標，比率、平均、最大、最小不適用。';
  if (pts.some((p) => (p.value as number) < 0)) return '圓餅圖不接受負數。';
  if (pts.length > 8) return '圓餅圖分類最多 8 項（目前 ' + pts.length + ' 項）。';
  return null;
}
export function defaultDrillColumns(topic: string): string[] {
  return topic === 'shipment' ? ['shipNo', 'shipDate', 'orderNo', 'customer', 'partName', 'shipQty', 'unit', 'shipAmountLocal']
    : ['orderNo', 'orderDate', 'customer', 'partName', 'qty', 'unit', 'amountLocal', 'basisDue', 'dueStatus'];
}
