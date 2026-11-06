// 報表執行：驗證 → 產生 SQL → 執行 → 組成前端要的結構。
import { getField, isRatioAgg } from './topics.ts';
import {
  addDays, addMonths, allErrors, buildExtra, defaultDrillColumns, monthStart, resolveRange, SUMMABLE_AGGS, weekStart, describeDef, fieldLabel, metricFmt, metricLabel, metricUnit, needsRelated, pieCheck,
  round2, STATUSES, synthDef, validateConditions, validateDef, validateExtra, widgetStatus
} from './engine.ts';
import type { Cond, Def, DashFilters, Err, Group, Metric, Widget } from './engine.ts';
import { BLANK, buildAggregate, buildDetail, dimOf, inlineParams } from './sqlgen.ts';
import type { Built } from './sqlgen.ts';

export type Row = Record<string, unknown>;
export type Exec = (q: Built) => Promise<Row[]>;
export const DEFAULT_LIMITS = { detailRows: 2000, groups: 500 };

export interface Svc {
  exec: Exec; today: string; limits: { detailRows: number; groups: number };
  log: { sql: string; ms: number; rows: number }[];
}
export function makeSvc(exec: Exec, today: string, limits = DEFAULT_LIMITS): Svc {
  const svc: Svc = { exec: async () => [], today, limits, log: [] };
  svc.exec = async (q) => {
    const t0 = Date.now(), rows = await exec(q);
    svc.log.push({ sql: inlineParams(q), ms: Date.now() - t0, rows: rows.length });
    return rows;
  };
  return svc;
}

/** 呼叫端可預期的業務錯誤（資料庫錯誤、上限）。HTTP 層轉成 ok:false 的回應。 */
export class ServiceError extends Error {
  code: string; status: number;
  constructor(code: string, msg: string, status = 400) { super(msg); this.code = code; this.status = status; }
}

function norm(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string') return v;
  return v === undefined ? null : v;
}
function num(v: unknown): number | null { return v == null ? null : Number(v); }

function colInfo(topic: string, id: string, label?: string | null) {
  const f = getField(topic, id)!;
  return { key: f.id, label: label || f.label, type: f.type, fmt: f.fmt, chip: f.chip, align: f.type === 'number' ? 'right' : 'left' };
}

function metricValue(m: Metric, v: unknown): number | null {
  const n = num(v);
  if (n == null) return null;
  return ['sum', 'avg'].includes(m.agg) || isRatioAgg(m.agg) ? round2(n) : n;
}
function groupKey(v: unknown): string { return v == null || v === '' ? BLANK : String(norm(v)); }

const base = (svc: Svc, def: Def, extra: Cond[]) => ({
  topic: def.topic, related: def.related, logic: def.filters.logic, conds: def.filters.rows, extra, today: svc.today
});

function cmpGroup(a: string, b: string, g: Group, topic: string): number {
  const f = getField(topic, g.field)!;
  if (f.id === 'dueStatus') return STATUSES.indexOf(a) - STATUSES.indexOf(b);
  return a < b ? -1 : a > b ? 1 : 0;
}

/* ---------- runReport ---------- */
export async function runReport(svc: Svc, def: Def, extra: Cond[], opts: { sort?: { key: string; dir: string } | null } = {}) {
  const topic = def.topic, errs = allErrors(def, extra);
  if (errs.length) return { ok: false as const, errors: errs };
  if (def.mode !== 'summary') {
    const ids = [...new Set(def.columns.map((c) => c.field))];
    const columns = def.columns.map((c) => colInfo(topic, c.field, c.label));
    const limit = svc.limits.detailRows;
    const raw = await svc.exec(buildDetail({ ...base(svc, def, extra), fields: ids, limit, sort: opts.sort }));
    const truncated = raw.length > limit;
    const rows = raw.slice(0, limit).map((r) => { const o: Row = {}; ids.forEach((id) => { o[id] = norm(r[id]); }); return o; });
    // 截斷時另跑 COUNT，count 才是符合條件的真實筆數（未截斷時就是回傳列數）
    const count = truncated ? Number(((await svc.exec(buildAggregate({ ...base(svc, def, extra), groups: [], metrics: [] })))[0] || {})._n || 0) : rows.length;
    return { ok: true as const, mode: 'detail', columns, rows, total: null, count, empty: rows.length === 0, truncated, limit };
  }
  const { groups, metrics } = def;
  const agg = { ...base(svc, def, extra), metrics };
  const [totRows, grpRows] = await Promise.all([
    svc.exec(buildAggregate({ ...agg, groups: [], withDims: true })),
    groups.length ? svc.exec(buildAggregate({ ...agg, groups, limit: svc.limits.groups })) : Promise.resolve([] as Row[])
  ]);
  const tot = totRows[0] || {}, count = Number(tot._n || 0);
  const mkRow = (r: Row, keys: string[]): Row => {
    const o: Row = { _n: Number(r._n), _keys: keys };
    groups.forEach((_g, i) => { o['g' + i] = keys[i]; });
    metrics.forEach((m) => { o['m_' + m.id] = metricValue(m, r['m_' + m.id]); });
    return o;
  };
  let out: Row[];
  if (groups.length) {
    if (grpRows.length > svc.limits.groups)
      throw new ServiceError('GROUP_OVERFLOW', '分組結果超過 ' + svc.limits.groups + ' 組，請縮小條件或改用較粗的分組（例如日期改依月）。');
    out = grpRows.map((r) => mkRow(r, groups.map((_g, i) => groupKey(r['g' + i]))));
  } else out = count ? [mkRow(tot, [])] : [];
  out.sort((a, b) => {
    const ka = a._keys as string[], kb = b._keys as string[];
    for (let i = 0; i < groups.length; i++) {
      const f = getField(topic, groups[i].field)!;
      let c: number;
      if (i === 0 && f.type !== 'date' && f.id !== 'dueStatus' && metrics.length) {
        const va = a['m_' + metrics[0].id] as number | null, vb = b['m_' + metrics[0].id] as number | null;
        c = (vb == null ? -1 : vb) - (va == null ? -1 : va);
      } else c = cmpGroup(ka[i], kb[i], groups[i], topic);
      if (c) return c;
      if (i === 0 && f.type !== 'date' && f.id !== 'dueStatus') { c = ka[0] < kb[0] ? -1 : ka[0] > kb[0] ? 1 : 0; if (c) return c; }
    }
    return 0;
  });
  // 合計列：另跑不分組查詢，比率與不重複數重新計算
  const total: Row = { _n: count };
  const notes: string[] = [];
  metrics.forEach((m) => {
    total['m_' + m.id] = metricValue(m, tot['m_' + m.id]);
    const dim = dimOf(topic, m);
    if (dim && Number(tot['_d_' + dim] || 0) > 1) {
      total['m_' + m.id] = null;
      notes.push('「' + getField(topic, m.field!)!.label + '」合計不顯示：各列' + (dim === 'currency' ? '幣別' : '單位') + '不同，不能混加。');
    }
  });
  total._notes = notes;
  const columns = groups.map((g, i) => {
    const f = getField(topic, g.field)!;
    return { key: 'g' + i, label: f.label + (f.type === 'date' ? (g.gran === 'day' ? '（依日）' : g.gran === 'week' ? '（依週）' : '（依月）') : ''), type: 'text', fmt: 'text', chip: f.chip, align: 'left', kind: 'group' };
  }).concat(metrics.map((m) => (
    { key: 'm_' + m.id, label: metricLabel(topic, m), type: 'number', fmt: metricFmt(topic, m), chip: false, align: 'right', kind: 'metric', metric: m } as never
  )));
  return { ok: true as const, mode: 'summary', columns, rows: out, total, count, empty: count === 0, truncated: false };
}
export type RunResult = Awaited<ReturnType<typeof runReport>>;

/* ---------- chartData ---------- */
export async function chartData(svc: Svc, w: Widget, report: Def | null, dash: { filters: DashFilters } | null) {
  const st = widgetStatus(w, report);
  if (!st.ok || !report) return { ok: false, invalid: true, code: st.code, reason: st.reason };
  const ex = buildExtra(w, report, dash, svc.today);
  if (w.type === 'table') {
    const res = await runReport(svc, report, ex.conds);
    return res.ok ? { ok: true, kind: 'table', result: res, ex } : { ok: false, errors: res.errors, ex };
  }
  if (!w.metric) return { ok: false, errors: [{ code: 'NO_METRIC', msg: 'widget 缺少指標' }] as Err[], ex };
  const def = synthDef(report, { type: w.type, category: w.category, metric: w.metric });
  const res = await runReport(svc, def, ex.conds);
  if (!res.ok) return { ok: false, errors: res.errors, ex };
  const m = def.metrics[0], topic = report.topic;
  const o = w.options || {};
  if (w.type === 'metric') {
    const value = (res.total as Row)['m_w'] as number | null;
    const compare = o.compare ? await compareOf(svc, w, report, dash, ex.conds, value, o.compare) : undefined;
    return { ok: true, kind: 'metric', value, fmt: metricFmt(topic, m), name: w.metricName || metricLabel(topic, w.metric),
      unit: w.unit != null ? w.unit : metricUnit(topic, m), n: res.count, ex, ...(compare !== undefined ? { compare } : {}) };
  }
  let pts: { key: string; label: string; value: number | null; n: number; cumPct?: number | null }[] =
    res.rows.map((r) => ({ key: (r._keys as string[])[0], label: (r._keys as string[])[0], value: r['m_w'] as number | null, n: r._n as number }));
  if (w.type === 'line') pts.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  if (w.type === 'bar') {
    if (o.cumulative && !SUMMABLE_AGGS.includes(w.metric.agg))
      return { ok: false, errors: [{ code: 'CUMULATIVE_NOT_SUMMABLE', msg: '累計占比只適用可加總的指標（筆數、加總），比率、平均、最大、最小不適用。' }] as Err[], ex };
    if (o.sort) { const dir = o.sort === 'asc' ? 1 : -1; pts.sort((a, b) => dir * ((a.value ?? 0) - (b.value ?? 0))); }
    if (o.cumulative) {
      const tot = pts.reduce((s, p) => s + (p.value ?? 0), 0);
      let acc = 0;
      pts.forEach((p) => { acc += p.value ?? 0; p.cumPct = tot ? round2(acc * 100 / tot) : null; }); // 分母是全部分類，不只顯示的前 N 項
    }
    if (o.limit) pts = pts.slice(0, o.limit);
  }
  const out: Row = { ok: true, kind: w.type, points: pts, total: (res.total as Row)['m_w'], fmt: metricFmt(topic, m), label: metricLabel(topic, w.metric), empty: res.empty, ex };
  if (w.type === 'pie') { const pe = pieCheck(w.metric.agg, pts); if (pe) { out.ok = false; out.typeError = pe; } }
  return out;
}

/* ---------- 與前 N 期平均比（指標卡） ---------- */
async function compareOf(svc: Svc, w: Widget, report: Def, dash: { filters: DashFilters } | null, conds: Cond[], value: number | null, c: { periods: number; gran: 'week' | 'month' }) {
  if (!w.dateField || !w.metric) return null;
  const f = (dash && dash.filters) || { range: 'all', from: '', to: '' };
  const own = w.options?.range, r = resolveRange(own || f.range || 'all', own ? '' : f.from, own ? '' : f.to, svc.today);
  if (!r || !r.from) return null; // 不限日期時沒有「本期」
  const start = c.gran === 'week' ? weekStart(r.from) : monthStart(r.from);
  const keys: string[] = [];
  for (let i = c.periods; i >= 1; i--) keys.push(c.gran === 'week' ? addDays(start, -7 * i) : addMonths(start, -i).slice(0, 7));
  const prev = conds.filter((x) => x.field !== w.dateField);
  prev.push({ id: '', field: w.dateField, op: 'custom', value: '', value2: '', values: [], from: c.gran === 'week' ? keys[0] : keys[0] + '-01', to: addDays(start, -1) });
  const def = synthDef({ ...report, columns: [...report.columns, { field: w.dateField, label: '' }] }, { type: 'bar', category: { field: w.dateField, gran: c.gran }, metric: w.metric });
  const res = await runReport(svc, def, prev);
  if (!res.ok) return null;
  const by = new Map(res.rows.map((x) => [(x._keys as string[])[0], x['m_w'] as number | null]));
  const summable = SUMMABLE_AGGS.includes(w.metric.agg);
  const vals = keys.map((k) => by.get(k) ?? (summable ? 0 : null)).filter((v): v is number => v != null);
  const baseline = vals.length ? round2(vals.reduce((s, v) => s + v, 0) / vals.length) : null;
  const deltaPct = baseline && value != null ? round2((value - baseline) / baseline * 100) : null;
  return { baseline, deltaPct, periods: c.periods, gran: c.gran };
}

/* ---------- drillRows ---------- */
export async function drillRows(svc: Svc, w: Widget, report: Def | null, dash: { filters: DashFilters } | null, clicked: { key: string } | null) {
  const st = widgetStatus(w, report);
  if (!st.ok || !report) return { ok: false, reason: st.reason };
  const topic = report.topic, ex = buildExtra(w, report, dash, svc.today);
  const errs: Err[] = [...validateConditions(report), ...validateExtra(report, ex.conds)];
  if (!errs.length && w.type !== 'table' && w.metric) errs.push(...validateDef(synthDef(report, { type: w.type, category: w.category, metric: w.metric }), ex.conds));
  if (errs.length) return { ok: false, errors: errs };
  let category: { group: Group; key: string } | null = null, catText: string | null = null;
  if (w.type !== 'table' && w.type !== 'metric' && clicked && w.category) {
    const g = { field: w.category.field, gran: w.category.gran || 'month' };
    category = { group: g, key: String(clicked.key) };
    catText = fieldLabel(topic, g.field) + ' = ' + clicked.key;
  }
  const colIds = (report.mode === 'detail' ? report.columns.map((c) => c.field) : defaultDrillColumns(topic)).filter((id) => getField(topic, id));
  // 預設下鑽欄位含交期結果時（如交期狀態），明細查詢自動帶入交期關聯（不影響列數）
  const related = { ...report.related };
  colIds.forEach((id) => { const f = getField(topic, id)!; if (needsRelated(topic, f)) related[f.grp] = true; });
  const common = { topic, logic: report.filters.logic, conds: report.filters.rows, extra: ex.conds, today: svc.today, category };
  const limit = svc.limits.detailRows;
  const metric: Metric | null = w.metric && w.type !== 'table' ? { id: 'w', agg: w.metric.agg, field: w.metric.field || null, label: '' } : null;
  const [raw, aggRows] = await Promise.all([
    svc.exec(buildDetail({ ...common, related, fields: colIds, limit })),
    svc.exec(buildAggregate({ ...common, related: report.related, groups: [], metrics: metric ? [metric] : [] }))
  ]);
  const truncated = raw.length > limit;
  const rows = raw.slice(0, limit).map((r) => { const o: Row = {}; colIds.forEach((id) => { o[id] = norm(r[id]); }); return o; });
  const columns = colIds.map((id) => {
    const c = report.columns.filter((x) => x.field === id)[0];
    return colInfo(topic, id, c && report.mode === 'detail' ? c.label : null);
  });
  const a = aggRows[0] || {};
  return {
    ok: true, rows, columns, value: metric ? metricValue(metric, a['m_w']) : null, fmt: metric ? metricFmt(topic, metric) : null,
    metricLabel: w.metric && w.type !== 'table' ? metricLabel(topic, w.metric) : null, categoryText: catText,
    reportTexts: describeDef(report, svc.today), dashTexts: ex.applied, notApplied: ex.notApplied, count: Number(a._n || 0), truncated, limit
  };
}

/* ---------- chartTypeOptions（需要資料的圓餅檢查，所以放在後端） ---------- */
export async function chartTypeOptions(svc: Svc, report: Def, cat: string | null, metric: Widget['metric'], gran: string | null) {
  const topic = report.topic, out: Row[] = [], hasMetric = !!metric;
  const catF = cat ? getField(topic, cat) : null;
  out.push({ type: 'table', enabled: true });
  out.push({ type: 'metric', enabled: hasMetric, reason: hasMetric ? '' : '請先選數值指標。', remedy: 'chart' });
  out.push({ type: 'bar', enabled: !!catF && hasMetric, reason: catF ? (hasMetric ? '' : '請先選數值指標。') : '長條圖需要一個分類欄位。已選欄位裡沒有可分類的欄位時，請回報表「步驟 2」加入（如客戶、交期狀態、日期）。', remedy: 'step2' });
  out.push({ type: 'line', enabled: !!catF && catF.type === 'date' && hasMetric,
    reason: catF && catF.type === 'date' ? (hasMetric ? '' : '請先選數值指標。') : '折線圖需要「日期」當分類。請把分類改成日期欄位；若報表沒有日期欄位，回「步驟 2」加入日期欄位後，再到「步驟 4」加入日期分組。', remedy: 'step4' });
  let pieReason = '';
  if (!catF || !metric) pieReason = '圓餅圖需要分類欄位與數值指標。';
  else {
    const w = { type: 'pie', category: { field: cat!, gran: gran || 'month' }, metric };
    const remedy = ' 補救：改選分類較少的欄位，或在報表「步驟 3」加條件縮小範圍。';
    try {
      const res = await runReport(svc, synthDef(report, w), []);
      if (!res.ok) pieReason = '目前的指標設定無法計算：' + res.errors[0].msg;
      else {
        const pts = res.rows.map((r) => ({ value: r['m_w'] as number | null }));
        pieReason = pieCheck(metric.agg, pts) || '';
        if (pieReason && pts.length > 8) pieReason += remedy;
      }
    } catch (e) {
      // 分類數超過分組上限（例如不限日期依日分類）必然超過 8 項：停用圓餅，不讓整個選項查詢失敗
      if (!(e instanceof ServiceError) || e.code !== 'GROUP_OVERFLOW') throw e;
      pieReason = '圓餅圖分類最多 8 項（目前超過 ' + svc.limits.groups + ' 項）。' + remedy;
    }
  }
  out.push({ type: 'pie', enabled: !pieReason, reason: pieReason, remedy: 'step4' });
  return out;
}

