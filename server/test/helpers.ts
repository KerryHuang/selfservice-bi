import { readFileSync, writeFileSync } from 'node:fs';
import { normCond, normDef } from '../engine.ts';
import { SEED_PATH } from '../store.ts';
import type { Cond, Def } from '../engine.ts';

export const TODAY = '2026-11-02';

export function def(o: Record<string, unknown>): Def {
  return normDef({ topic: 'orderLine', related: { delivery: false }, filters: { logic: 'all', rows: [] }, mode: 'summary', groups: [], metrics: [], columns: [], ...o });
}
export const cols = (...ids: string[]): { field: string; label: string }[] => ids.map((field) => ({ field, label: '' }));
export function cond(o: Record<string, unknown>): Cond { return normCond({ id: 'c', value: '', value2: '', values: [], from: '', to: '', ...o }); }
export const m = (id: string, agg: string, field: string | null = null): Record<string, unknown> => ({ id, agg, field, label: '' });

/** 種子資料再加上一份刻意失效的儀表板，供失效判定與權限測試使用。 */
export function writeSeedWithStale(path: string): void {
  const seed = JSON.parse(readFileSync(SEED_PATH, 'utf8'));
  seed.dashboards.push(JSON.parse(readFileSync(new URL('./fixtures/stale-dashboard.json', import.meta.url), 'utf8')));
  writeFileSync(path, JSON.stringify(seed));
}
