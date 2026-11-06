// 報表／儀表板存放：單一 JSON 檔，寫入用暫存檔＋rename（原子替換）。
// 角色儀表板（kind:'role'）由管理員維護並派給角色；主管儲存角色儀表板會變成自己的個人版（kind:'personal'，baseId 指回角色版）。
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSIGNABLE, ROLES } from './viewer.ts';
import type { RoleCode } from './viewer.ts';

export const STORE_PATH = fileURLToPath(new URL('../data/store.json', import.meta.url));
export const SEED_PATH = fileURLToPath(new URL('../data/seed.json', import.meta.url));   // 種子資料（唯讀；管理員「還原預設」用）
export type Item = { id: string; [k: string]: unknown };
export type Kind = 'reports' | 'dashboards';
export interface StateV2 { v: 2; reports: Item[]; dashboards: Item[]; roleHome: Partial<Record<RoleCode, string>>; seq: number }

export class Forbidden extends Error { code: string; constructor(code: string, msg: string) { super(msg); this.code = code; } }
export class NotFound extends Error {}

/** 回應時才算的欄位，不落檔 */
const DERIVED = ['readonly', 'roleUpdated'];
/** 由伺服器決定的欄位，不接受請求內容覆寫 */
const SYSTEM = ['kind', 'roles', 'ownerId', 'version', 'baseId', 'baseVersion', 'shared', 'updatedAt'];

function load(path: string, seedPath?: string): { state: StateV2; seeded: boolean } {
  if (!existsSync(path)) {
    if (!seedPath) return { state: { v: 2, reports: [], dashboards: [], roleHome: {}, seq: 100 }, seeded: false };
    return { state: JSON.parse(readFileSync(seedPath, 'utf8')), seeded: true };   // 首次啟動：以種子開局，並立即落檔
  }
  return { state: JSON.parse(readFileSync(path, 'utf8')), seeded: false };
}
function clean(body: Item): Item {
  const o: Item = { ...body };
  for (const k of [...DERIVED, ...SYSTEM]) delete o[k];
  return o;
}
function rolesOf(x: unknown): RoleCode[] {
  if (!Array.isArray(x)) return [];
  return [...new Set(x.filter((r): r is RoleCode => ASSIGNABLE.includes(r as RoleCode)))];
}

export function createStore(path = STORE_PATH, seedPath?: string) {
  const { state, seeded } = load(path, seedPath);
  let chain: Promise<void> = Promise.resolve();
  function persist(): Promise<void> {
    const snap = JSON.stringify(state, null, 2);
    chain = chain.then(async () => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path + '.tmp', snap, 'utf8');
      await rename(path + '.tmp', path);
    });
    return chain;
  }
  if (seeded) void persist();
  const now = (): string => {
    const d = new Date(), p = (n: number): string => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const get = (k: Kind, id: string): Item | null => state[k].find((x) => x.id === id) || null;
  const newId = (k: Kind, want?: unknown): string => {
    if (typeof want === 'string' && want && !state[k].some((x) => x.id === want)) return want;
    state.seq++; return (k === 'reports' ? 'r' : 'd') + state.seq;
  };
  const personalOf = (viewer: RoleCode, baseId: string): Item | null =>
    state.dashboards.find((d) => d.kind === 'personal' && d.ownerId === viewer && d.baseId === baseId) || null;
  const adminOnly = (viewer: RoleCode): void => { if (viewer !== 'admin') throw new Forbidden('ADMIN_ONLY', '只有管理員可以做這個操作'); };
  const canSeeReport = (viewer: RoleCode, r: Item): boolean => viewer === 'admin' || r.shared === true || r.ownerId === viewer;
  const canSeeDash = (viewer: RoleCode, d: Item): boolean =>
    viewer === 'admin' || (d.kind === 'role' ? rolesOf(d.roles).includes(viewer) : d.ownerId === viewer);
  const checkReportWrite = (viewer: RoleCode, r: Item): void => {
    if (viewer === 'admin') return;
    if (r.shared === true) throw new Forbidden('SHARED_READONLY', '共用報表只有管理員能修改，請另存一份');
    if (r.ownerId !== viewer) throw new Forbidden('NOT_OWNER', '不能修改別人的報表');
  };

  return {
    state: (): StateV2 => state,
    list: (k: Kind): Item[] => state[k],
    get,
    /** 該 viewer 看得到才回傳；看不到與不存在一樣回 null。報表被看得到的儀表板引用時也算看得到。 */
    getVisible(viewer: RoleCode, k: Kind, id: string): Item | null {
      const it = get(k, id);
      if (!it) return null;
      if (k === 'dashboards') return canSeeDash(viewer, it) ? it : null;
      if (canSeeReport(viewer, it)) return it;
      return state.dashboards.some((d) => canSeeDash(viewer, d) && (d.widgets as Item[] || []).some((w) => w.reportId === id)) ? it : null;
    },

    /** 該 viewer 看得到的報表與儀表板（個人版取代對應的角色版）。 */
    visibleState(viewer: RoleCode) {
      const reports = state.reports.filter((r) => canSeeReport(viewer, r))
        .map((r) => ({ ...r, readonly: viewer !== 'admin' && (r.shared === true || r.ownerId !== viewer) }));
      const dashboards: Item[] = [];
      const used = new Set<string>();
      for (const d of state.dashboards) {
        if (d.kind !== 'role') continue;
        if (viewer !== 'admin' && !rolesOf(d.roles).includes(viewer)) continue;
        const p = viewer === 'admin' ? null : personalOf(viewer, d.id);
        if (p) { used.add(p.id); dashboards.push({ ...p, roleUpdated: Number(p.baseVersion || 0) < Number(d.version || 0) }); }
        else dashboards.push(d);
      }
      for (const p of state.dashboards) if (p.kind === 'personal' && p.ownerId === viewer && !used.has(p.id)) dashboards.push(p);
      let home: string | null = viewer === 'admin' ? null : state.roleHome[viewer] ?? null;
      if (home) { const p = personalOf(viewer, home); if (p) home = p.id; }
      return { reports, dashboards, home, roles: ROLES, ...(viewer === 'admin' ? { roleHome: state.roleHome } : {}) };
    },

    async createDashboard(viewer: RoleCode, body: Item): Promise<Item> {
      const base = clean(body);
      let item: Item;
      if (body.kind === 'role') {
        adminOnly(viewer);
        const roles = rolesOf(body.roles);
        if (!roles.length) throw new Forbidden('NO_ROLES', '角色儀表板至少要派給一個角色');
        item = { ...base, id: newId('dashboards', body.id), kind: 'role', roles, version: 1, updatedAt: now() };
      } else item = { ...base, id: newId('dashboards', body.id), kind: 'personal', ownerId: viewer, version: 1, updatedAt: now() };
      state.dashboards.push(item); await persist(); return item;
    },
    async saveDashboard(viewer: RoleCode, id: string, body: Item): Promise<Item> {
      const cur = get('dashboards', id);
      if (!cur) throw new NotFound('不存在');
      const base = clean(body);
      let item: Item;
      if (cur.kind === 'role') {
        if (viewer !== 'admin') {
          if (!rolesOf(cur.roles).includes(viewer)) throw new Forbidden('NOT_ASSIGNED', '這份角色儀表板沒有派給你');
          const p = personalOf(viewer, id);
          item = { ...base, id: p ? p.id : newId('dashboards'), kind: 'personal', ownerId: viewer, version: 1, baseId: id, baseVersion: cur.version, updatedAt: now() };
          if (p) state.dashboards[state.dashboards.indexOf(p)] = item; else state.dashboards.push(item);
          await persist(); return item;
        }
        const roles = body.roles === undefined ? rolesOf(cur.roles) : rolesOf(body.roles);
        if (!roles.length) throw new Forbidden('NO_ROLES', '角色儀表板至少要派給一個角色');
        item = { ...base, id, kind: 'role', roles, version: Number(cur.version || 1) + 1, updatedAt: now() };
      } else {
        if (cur.ownerId !== viewer) throw new Forbidden('NOT_OWNER', '不能修改別人的儀表板');
        item = { ...base, id, kind: 'personal', ownerId: viewer, version: 1, updatedAt: now() };
        if (cur.baseId) { item.baseId = cur.baseId; item.baseVersion = cur.baseVersion; }
      }
      state.dashboards[state.dashboards.indexOf(cur)] = item; await persist(); return item;
    },
    async removeDashboard(viewer: RoleCode, id: string): Promise<void> {
      const cur = get('dashboards', id);
      if (!cur) throw new NotFound('不存在');
      if (cur.kind === 'role') {
        adminOnly(viewer);
        for (const d of state.dashboards) if (d.baseId === id) { delete d.baseId; delete d.baseVersion; }
        for (const r of Object.keys(state.roleHome) as RoleCode[]) if (state.roleHome[r] === id) delete state.roleHome[r];
      } else if (cur.ownerId !== viewer) throw new Forbidden('NOT_OWNER', '不能刪除別人的儀表板');
      state.dashboards.splice(state.dashboards.indexOf(cur), 1); await persist();
    },
    /** 還原成角色預設：刪除該 viewer 以 roleId 為底的個人版。 */
    async restoreDashboard(viewer: RoleCode, roleId: string): Promise<void> {
      const p = personalOf(viewer, roleId);
      if (!p) return;
      state.dashboards.splice(state.dashboards.indexOf(p), 1); await persist();
    },
    async setRoleHome(viewer: RoleCode, role: string, id: string): Promise<void> {
      adminOnly(viewer);
      if (!ASSIGNABLE.includes(role as RoleCode)) throw new Forbidden('BAD_ROLE', '角色不存在：' + role);
      const d = get('dashboards', id);
      if (!d || d.kind !== 'role') throw new NotFound('角色儀表板不存在');
      state.roleHome[role as RoleCode] = id; await persist();
    },

    async createReport(viewer: RoleCode, body: Item): Promise<Item> {
      const item: Item = { ...clean(body), id: newId('reports', body.id), ownerId: viewer, shared: viewer === 'admin' && body.shared === true, updatedAt: now() };
      state.reports.push(item); await persist(); return item;
    },
    async saveReport(viewer: RoleCode, id: string, body: Item): Promise<Item> {
      const cur = get('reports', id);
      if (!cur) throw new NotFound('不存在');
      checkReportWrite(viewer, cur);
      const shared = viewer === 'admin' && body.shared !== undefined ? body.shared === true : cur.shared === true;
      const item: Item = { ...clean(body), id, ownerId: cur.ownerId, shared, updatedAt: now() };
      state.reports[state.reports.indexOf(cur)] = item; await persist(); return item;
    },
    async removeReport(viewer: RoleCode, id: string): Promise<void> {
      const cur = get('reports', id);
      if (!cur) throw new NotFound('不存在');
      checkReportWrite(viewer, cur);
      const users = state.dashboards.filter((d) => (d.widgets as Item[] || []).some((w) => w.reportId === id));
      if (users.length) throw new Forbidden('REPORT_IN_USE', '這份報表被 ' + users.length + ' 份儀表板引用，請先移除那些卡片');
      state.reports.splice(state.reports.indexOf(cur), 1); await persist();
    },

    /** 還原成種子資料（data/seed.json）；就地換掉 state 內容 */
    async reset(seedPath = SEED_PATH): Promise<StateV2> {
      const raw = JSON.parse(readFileSync(seedPath, 'utf8'));
      const seed: StateV2 = raw;
      state.reports = seed.reports; state.dashboards = seed.dashboards; state.roleHome = seed.roleHome; state.seq = seed.seq;
      await persist(); return state;
    }
  };
}
export type Store = ReturnType<typeof createStore>;
