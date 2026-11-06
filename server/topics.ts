// 載入 config/topics.json：欄位定義層，也是 SQL 的唯一白名單。啟動時逐段驗證，不通過就拒絕啟動。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assertSafeFragment } from './guard.ts';

export type FieldType = 'text' | 'number' | 'date' | 'enum';
export interface Field {
  id: string; label: string; type: FieldType; grp: string; kind: string; notSummable: string | null;
  displayOnly: boolean; fmt: string; chip: boolean; opts: string[] | null; sql: string;
}
/** 比率型彙總：逐列分子／分母運算式（可用 {欄位id} 引用欄位），依分組 SUM(分子)×scale÷SUM(分母)。 */
export interface Ratio { id: string; label: string; num: string; den: string; scale: number; unit: string; note: string | null; fields: string[] }
export interface Topic {
  id: string; label: string; rowText: string; countLabel: string; groups: Record<string, string>;
  from: string; where: string; related: Record<string, string>; keys: Record<string, string>;
  dateFields: string[]; fields: Field[]; map: Record<string, Field>; ratios: Record<string, Ratio>;
}
export type Catalog = Record<string, Topic>;

const IDENT = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const TYPES = ['text', 'number', 'date', 'enum'];

export const DEFAULT_TOPICS_PATH = fileURLToPath(new URL('../config/topics.json', import.meta.url));

export function parseTopics(raw: any): Catalog {
  const out: Catalog = {};
  for (const [tid, t] of Object.entries<any>(raw.topics || {})) {
    if (!IDENT.test(tid)) throw new Error('topic id 不合法：' + tid);
    for (const key of ['from', 'where'] as const) assertSafeFragment(t[key], tid + '.' + key);
    const related: Record<string, string> = t.related || {};
    for (const [g, s] of Object.entries(related)) assertSafeFragment(s, tid + '.related.' + g);
    const keys: Record<string, string> = t.keys || {};
    for (const [k, s] of Object.entries(keys)) { assertSafeFragment(s, tid + '.keys.' + k); if (!IDENT.test(k)) throw new Error('key 名稱不合法：' + k); }
    const fields: Field[] = [], map: Record<string, Field> = {};
    for (const f of t.fields as any[]) {
      if (!IDENT.test(f.id)) throw new Error('field id 不合法：' + tid + '.' + f.id);
      if (!TYPES.includes(f.type)) throw new Error('field type 不合法：' + tid + '.' + f.id);
      if (map[f.id]) throw new Error('field id 重複：' + tid + '.' + f.id);
      assertSafeFragment(f.sql, tid + '.fields.' + f.id);
      if (f.grp !== 'main' && !(f.grp in (t.groups || {}))) throw new Error('field grp 未定義：' + tid + '.' + f.id);
      const nf: Field = {
        id: f.id, label: f.label, type: f.type, grp: f.grp, kind: f.kind || 'plain', notSummable: f.notSummable || null,
        displayOnly: !!f.displayOnly, fmt: f.fmt || (f.type === 'number' ? 'num' : f.type === 'date' ? 'date' : 'text'),
        chip: !!f.chip, opts: Array.isArray(f.opts) ? f.opts : null, sql: f.sql
      };
      fields.push(nf); map[nf.id] = nf;
    }
    for (const d of t.dateFields || []) if (!map[d] || map[d].type !== 'date') throw new Error('dateFields 含非日期欄位：' + d);
    const ratios: Record<string, Ratio> = {};
    for (const [rid, r] of Object.entries<any>(t.ratios || {})) {
      if (!IDENT.test(rid)) throw new Error('ratio id 不合法：' + tid + '.' + rid);
      const refs = new Set<string>();
      const sub = (expr: string, part: string): string => {
        if (typeof expr !== 'string' || !expr.trim()) throw new Error('ratio 缺少 ' + part + '：' + tid + '.' + rid);
        assertSafeFragment(expr, tid + '.ratios.' + rid + '.' + part);
        return expr.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_m, id: string) => {
          if (!map[id]) throw new Error('ratio 引用不存在的欄位：' + tid + '.' + rid + ' → ' + id);
          refs.add(id); return '(' + map[id].sql + ')';
        });
      };
      ratios[rid] = { id: rid, label: r.label, num: sub(r.num, 'num'), den: sub(r.den, 'den'), scale: Number(r.scale ?? 100), unit: r.unit ?? '%', note: r.note || null, fields: [...refs] };
    }
    out[tid] = {
      id: tid, label: t.label, rowText: t.rowText, countLabel: t.countLabel, groups: t.groups || {}, from: t.from, where: t.where,
      related, keys, dateFields: t.dateFields || [], fields, map, ratios
    };
  }
  if (!Object.keys(out).length) throw new Error('topics.json 沒有任何主題');
  return out;
}

export function loadTopics(path = DEFAULT_TOPICS_PATH): Catalog {
  return parseTopics(JSON.parse(readFileSync(path, 'utf8')));
}

// null prototype：使用者送來的主題名稱（__proto__、constructor）查不到東西
export const CATALOG: Catalog = Object.assign(Object.create(null), loadTopics());

export function getField(topic: string, id: string): Field | null {
  const t = CATALOG[topic];
  return t && Object.hasOwn(t.map, id) ? t.map[id] : null;
}

/** agg 字串對應的比率定義（'ratio:<id>'；'onTimeRate' 等同訂單明細的 ratio:onTime）。 */
export function ratioOf(topic: string, agg: string): Ratio | null {
  const t = CATALOG[topic]; if (!t) return null;
  const id = agg === 'onTimeRate' ? 'onTime' : agg.startsWith('ratio:') ? agg.slice(6) : null;
  return id && Object.hasOwn(t.ratios, id) ? t.ratios[id] : null;
}
export function isRatioAgg(agg: string): boolean { return agg === 'onTimeRate' || agg.startsWith('ratio:'); }
