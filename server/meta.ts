// GET /api/meta：前端需要的目錄（不含 sql）。enum 選項由 SELECT DISTINCT（上限 200）取得並快取。
import { CATALOG } from './topics.ts';
import { AGG_LABELS, LIMITS, OPS, RANGE_LABELS, STATUSES } from './engine.ts';
import { buildDistinct } from './sqlgen.ts';
import { DEFAULT_LIMITS } from './service.ts';
import type { Exec } from './service.ts';

const TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; opts: string[] }>();

export function clearOptsCache(): void { cache.clear(); }

async function enumOpts(exec: Exec | null, topic: string, field: string, today: string): Promise<string[]> {
  const key = topic + '.' + field, hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.opts;
  if (!exec) throw new Error('DB 未設定');
  const rows = await exec(buildDistinct(topic, field, 200, today));
  const opts = rows.map((r) => String(r.v));
  cache.set(key, { at: Date.now(), opts });
  return opts;
}

export async function buildMeta(exec: Exec | null, today: string) {
  const TOPICS: Record<string, unknown> = {}, FIELDS: Record<string, unknown[]> = {}, DATE_FIELDS: Record<string, string[]> = {}, optsErrors: Record<string, string> = {};
  for (const t of Object.values(CATALOG)) {
    TOPICS[t.id] = { label: t.label, rowText: t.rowText, countLabel: t.countLabel, groups: t.groups, related: Object.keys(t.related),
      ratios: Object.fromEntries(Object.values(t.ratios).map((r) => [r.id, { label: r.label, unit: r.unit, note: r.note, groups: [...new Set(r.fields.map((f) => t.map[f].grp))] }])) };
    DATE_FIELDS[t.id] = t.dateFields;
    FIELDS[t.id] = await Promise.all(t.fields.map(async (f) => {
      let opts = f.opts;
      if (f.type === 'enum' && !opts) {
        try { opts = await enumOpts(exec, t.id, f.id, today); } catch (e) { opts = []; optsErrors[t.id + '.' + f.id] = String((e as Error).message).slice(0, 200); }
      }
      return { id: f.id, label: f.label, type: f.type, grp: f.grp, kind: f.kind, notSummable: f.notSummable, displayOnly: f.displayOnly, fmt: f.fmt, opts, chip: f.chip };
    }));
  }
  return { today, asOf: today, TOPICS, FIELDS, OPS, STATUSES, RANGE_LABELS, DATE_FIELDS, AGG_LABELS, limits: { ...DEFAULT_LIMITS, ...LIMITS }, optsErrors };
}
