// 查詢結果快取：鍵＝SQL 文字＋參數（asOf 在參數裡），不分 viewer；預設 10 分鐘。
import type { Row } from './service.ts';
import type { Built } from './sqlgen.ts';

export const DEFAULT_TTL_MS = 10 * 60 * 1000;
// 訪客能送出任意多種查詢，要限制記憶體用量：免費方案只有 512 MB。
export const MAX_CACHED_ROWS = 100_000, MAX_CACHED_ENTRIES = 1000;
export interface Cached { rows: Row[]; fetchedAt: number }

export function createCache(exec: (q: Built) => Promise<Row[]>, opts: { ttlMs?: number; now?: () => number; maxRows?: number; maxEntries?: number } = {}) {
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS, now = opts.now ?? Date.now;
  const maxRows = opts.maxRows ?? MAX_CACHED_ROWS, maxEntries = opts.maxEntries ?? MAX_CACHED_ENTRIES;
  const done = new Map<string, Cached>(), pending = new Map<string, Promise<Cached>>();
  return {
    async exec(q: Built, o: { refresh?: boolean } = {}): Promise<Cached> {
      const key = q.text + '\u0000' + JSON.stringify(q.params);
      if (!o.refresh) {
        const hit = done.get(key);
        if (hit && now() - hit.fetchedAt < ttl) return hit;
        const p = pending.get(key);
        if (p) return p;
      }
      const p = exec(q).then((rows) => {
        const r = { rows, fetchedAt: now() };
        done.delete(key);
        for (const [k, v] of done) if (r.fetchedAt - v.fetchedAt >= ttl) done.delete(k); // 過期項目順手清掉
        if (rows.length > maxRows) return r;
        done.set(key, r);
        let total = 0;
        for (const v of done.values()) total += v.rows.length;
        for (const [k, v] of done) { // Map 依插入順序，最舊的在前面
          if (total <= maxRows && done.size <= maxEntries) break;
          done.delete(k); total -= v.rows.length;
        }
        return r;
      });
      pending.set(key, p);
      try { return await p; } finally { if (pending.get(key) === p) pending.delete(key); }
    },
    clear(): void { done.clear(); pending.clear(); },
    size: (): number => done.size
  };
}
export type Cache = ReturnType<typeof createCache>;

/** 「重新整理」節流：同一 viewer 在 windowMs 內只放行一次。 */
/** 同一 viewer 60 秒內只放行一次重新整理；放行後 burstMs 內的請求（同一頁其他卡片）算同一次。 */
export function createRefreshGate(opts: { windowMs?: number; burstMs?: number; now?: () => number } = {}) {
  const win = opts.windowMs ?? 60000, burst = opts.burstMs ?? 10000, now = opts.now ?? Date.now, last = new Map<string, number>();
  return {
    allow(viewer: string): boolean {
      const t = now(), prev = last.get(viewer);
      if (prev != null && t - prev < burst) return true;
      if (prev != null && t - prev < win) return false;
      last.set(viewer, t); return true;
    }
  };
}
