// HTTP 層（node:http）：路由、請求驗證、錯誤對應。
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createCache, createRefreshGate } from './cache.ts';
import { BadRequest, isIsoDate, normConds, normDash, normDef, normWidget } from './engine.ts';
import type { Def, DashFilters } from './engine.ts';
import { SqlGuardError } from './guard.ts';
import { buildMeta } from './meta.ts';
import { chartData, chartTypeOptions, drillRows, makeSvc, runReport, ServiceError, DEFAULT_LIMITS } from './service.ts';
import type { Exec, Svc } from './service.ts';
import { Forbidden, NotFound } from './store.ts';
import type { RoleCode } from './viewer.ts';
import type { Item, Kind, Store } from './store.ts';
import { viewerOf } from './viewer.ts';
import { CATALOG, getField } from './topics.ts';

const WEB_INDEX = fileURLToPath(new URL('../web/index.html', import.meta.url));
// 公開站的防濫用上限：全站共用同一份資料，訪客也能建立內容
export const MAX_BODY = 64 * 1024, MAX_ITEM_BYTES = 32 * 1024, MAX_REPORTS = 200, MAX_DASHBOARDS = 50;

export interface Deps { exec: Exec; store: Store; asOf: string; limits?: { detailRows: number; groups: number }; cacheTtlMs?: number }

class HttpError extends Error { status: number; constructor(status: number, msg: string) { super(msg); this.status = status; } }

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let n = 0;
    req.on('data', (c: Buffer) => { n += c.length; if (n > MAX_BODY) reject(new HttpError(413, '請求過大')); else chunks.push(c); }); // 超過後只丟棄不中斷，用戶端才收得到 413
    req.on('end', () => {
      if (!n) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new BadRequest('請求內容不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}
function asObj(x: unknown): Record<string, unknown> {
  if (x == null || typeof x !== 'object' || Array.isArray(x)) throw new BadRequest('請求內容必須是 JSON 物件');
  return x as Record<string, unknown>;
}
function send(res: http.ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(s);
}
function errBody(code: string, msg: string): { ok: false; errors: { code: string; msg: string }[] } { return { ok: false, errors: [{ code, msg }] }; }

function validateItem(kind: Kind, body: unknown): Item {
  const b = asObj(body);
  if (Buffer.byteLength(JSON.stringify(b)) > MAX_ITEM_BYTES) throw new BadRequest('內容過大，請減少欄位或卡片');
  if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 100) throw new BadRequest('name 必填，且不可超過 100 字');
  if (b.id != null && (typeof b.id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(b.id))) throw new BadRequest('id 只能是英數、底線、連字號（40 字內）');
  if (kind === 'reports') {
    const d = normDef(b);
    if (!CATALOG[d.topic]) throw new BadRequest('topic 不存在：' + d.topic);
    const ids = [...d.columns.map((c) => c.field), ...d.groups.map((g) => g.field), ...d.metrics.map((m) => m.field), ...d.filters.rows.map((c) => c.field)];
    for (const id of ids) if (id && !getField(d.topic, id)) throw new BadRequest('欄位不存在：' + id);
  } else {
    if (!Array.isArray(b.widgets) || b.widgets.length > 50) throw new BadRequest('widgets 必須是陣列（上限 50）');
    b.widgets.forEach((w) => normWidget(w));
    normDash(b);
  }
  return b as Item;
}

export function createApp(deps: Deps): http.Server {
  const { exec, store } = deps;
  const limits = deps.limits || DEFAULT_LIMITS;
  const cache = createCache(exec, { ttlMs: deps.cacheTtlMs }), gate = createRefreshGate();
  function todayOf(b: Record<string, unknown>): string {
    if (b.today == null || b.today === '') return deps.asOf;
    if (typeof b.today !== 'string' || !isIsoDate(b.today)) throw new BadRequest('today 必須是 YYYY-MM-DD');
    return b.today;
  }
  type Ctx = Svc & { fetched: number[]; refreshIgnored: boolean };

  function ctxOf(b: Record<string, unknown>, req: http.IncomingMessage): Ctx {
    const want = req.headers['x-refresh'] === '1';
    const viewer = String(req.headers['x-viewer'] || 'anon');
    const refresh = want && gate.allow(viewer);
    const fetched: number[] = [];
    const svc = makeSvc(async (q) => { const r = await cache.exec(q, { refresh }); fetched.push(r.fetchedAt); return r.rows; }, todayOf(b), limits);
    return Object.assign(svc, { fetched, refreshIgnored: want && !refresh });
  }
  function metaOf(svc: Ctx, b: Record<string, unknown>, t0: number) {
    return {
      ms: Date.now() - t0, today: svc.today, queries: svc.log.map((l) => ({ ms: l.ms, rows: l.rows })),
      dataTime: svc.fetched.length ? new Date(Math.min(...svc.fetched)).toISOString() : null,
      ...(svc.refreshIgnored ? { refreshIgnored: true } : {}),
      ...(b.debug === true ? { sql: svc.log.map((l) => l.sql) } : {})
    };
  }
  function reportOf(b: Record<string, unknown>, viewer: RoleCode): Def | null {
    if (b.report != null) return normDef(b.report);
    if (typeof b.reportId === 'string') { const r = store.getVisible(viewer, 'reports', b.reportId); if (!r && store.get('reports', b.reportId)) throw new NotFound('不存在'); return r ? normDef(r) : null; }
    throw new BadRequest('需要 report 或 reportId');
  }
  function dashOf(b: Record<string, unknown>, viewer: RoleCode): { filters: DashFilters } | null {
    if (b.dash != null) return normDash(b.dash);
    if (typeof b.dashId === 'string') { const d = store.getVisible(viewer, 'dashboards', b.dashId); if (!d && store.get('dashboards', b.dashId)) throw new NotFound('不存在'); return d ? normDash(d) : null; }
    return null;
  }

  async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', 'http://x'), path = url.pathname, method = req.method || 'GET';
    const t0 = Date.now();

    if (method === 'GET' && path === '/') {
      const html = await readFile(WEB_INDEX);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); return;
    }
    if (!path.startsWith('/api/')) throw new HttpError(404, '找不到');

    if (method === 'GET' && path === '/api/health') return send(res, 200, { ok: true });
    if (method === 'GET' && path === '/api/meta') return send(res, 200, await buildMeta(exec, deps.asOf));
    const viewer = viewerOf(req);
    if (method === 'GET' && path === '/api/state') return send(res, 200, store.visibleState(viewer));

    if (method === 'POST' && path === '/api/run') {
      const b = asObj(await readBody(req)), svc = ctxOf(b, req);
      const sort = b.sort == null ? null : asObj(b.sort);
      const r = await runReport(svc, normDef(b.def), normConds(b.extra), { sort: sort ? { key: String(sort.key || ''), dir: sort.dir === 'desc' ? 'desc' : 'asc' } : null });
      return send(res, 200, { ...r, meta: metaOf(svc, b, t0) });
    }
    if (method === 'POST' && path === '/api/chart') {
      const b = asObj(await readBody(req)), svc = ctxOf(b, req);
      const r = await chartData(svc, normWidget(b.widget), reportOf(b, viewer), dashOf(b, viewer));
      return send(res, 200, { ...r, meta: metaOf(svc, b, t0) });
    }
    if (method === 'POST' && path === '/api/drill') {
      const b = asObj(await readBody(req)), svc = ctxOf(b, req);
      const clicked = b.clicked == null ? null : asObj(b.clicked);
      if (clicked && typeof clicked.key !== 'string') throw new BadRequest('clicked.key 必須是文字');
      const r = await drillRows(svc, normWidget(b.widget), reportOf(b, viewer), dashOf(b, viewer), clicked ? { key: clicked.key as string } : null);
      return send(res, 200, { ...r, meta: metaOf(svc, b, t0) });
    }
    if (method === 'POST' && path === '/api/chart-options') {
      const b = asObj(await readBody(req)), svc = ctxOf(b, req);
      const report = reportOf(b, viewer);
      if (!report) throw new HttpError(404, '報表不存在');
      const met = b.metric == null ? null : normWidget({ type: 'metric', metric: b.metric }).metric;
      const r = await chartTypeOptions(svc, report, typeof b.category === 'string' ? b.category : null, met, typeof b.gran === 'string' ? b.gran : null);
      return send(res, 200, { ok: true, options: r, meta: metaOf(svc, b, t0) });
    }

    // CRUD（依 viewer 決定可見範圍與可否修改）
    const rm = /^\/api\/dashboards\/([^/]+)\/restore$/.exec(path);
    if (rm && method === 'POST') { await store.restoreDashboard(viewer, decodeURIComponent(rm[1])); return send(res, 200, { ok: true }); }
    const m = /^\/api\/(reports|dashboards)(?:\/([^/]+))?$/.exec(path);
    if (m) {
      const kind = m[1] as Kind, id = m[2] ? decodeURIComponent(m[2]) : null, isRep = kind === 'reports';
      if (!id) {
        if (method === 'GET') return send(res, 200, store.visibleState(viewer)[kind]);
        if (method === 'POST') {
          const body = validateItem(kind, await readBody(req));
          if (store.state()[kind].length >= (isRep ? MAX_REPORTS : MAX_DASHBOARDS)) throw new ServiceError('LIMIT_REACHED', '示範站的' + (isRep ? '報表' : '儀表板') + '數量已達上限，請刪除不用的項目，或等站台重啟後還原。', 409);
          return send(res, 201, isRep ? await store.createReport(viewer, body) : await store.createDashboard(viewer, body));
        }
      } else {
        if (method === 'GET') { const it = store.getVisible(viewer, kind, id); if (!it) throw new HttpError(404, '不存在'); return send(res, 200, it); }
        if (method === 'PUT') {
          const body = validateItem(kind, await readBody(req));
          return send(res, 200, isRep ? await store.saveReport(viewer, id, body) : await store.saveDashboard(viewer, id, body));
        }
        if (method === 'DELETE') { await (isRep ? store.removeReport(viewer, id) : store.removeDashboard(viewer, id)); return send(res, 200, { ok: true }); }
      }
    }
    if (method === 'POST' && path === '/api/reset') {
      if (viewer !== 'admin') throw new Forbidden('ADMIN_ONLY', '只有管理員可以還原預設');
      await store.reset(); return send(res, 200, { ok: true });
    }
    if (method === 'PUT' && path === '/api/role-home') {
      const b = asObj(await readBody(req));
      if (typeof b.role !== 'string' || typeof b.id !== 'string') throw new BadRequest('需要 role 與 id');
      await store.setRoleHome(viewer, b.role, b.id); return send(res, 200, { ok: true });
    }
    throw new HttpError(404, '找不到');
  }

  return http.createServer((req, res) => {
    route(req, res).catch((e: unknown) => {
      if (res.headersSent) { res.end(); return; }
      if (e instanceof BadRequest) return send(res, 400, errBody('BAD_REQUEST', e.message));
      if (e instanceof ServiceError) return send(res, e.status, errBody(e.code, e.message));
      if (e instanceof HttpError) return send(res, e.status, errBody('HTTP_' + e.status, e.message));
      if (e instanceof Forbidden) return send(res, 403, errBody(e.code, e.message));
      if (e instanceof NotFound) return send(res, 404, errBody('HTTP_404', e.message));
      if (e instanceof SqlGuardError) { console.error('[guard]', e.message); return send(res, 500, errBody('SQL_GUARD', '產生的 SQL 未通過安全檢查，已拒絕執行。')); }
      console.error(e);
      send(res, 500, errBody('INTERNAL', '伺服器內部錯誤'));
    });
  });
}

