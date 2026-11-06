// 模擬身分：前端頂列的角色選單，經 X-Viewer 標頭送來。示範站沒有登入。
import type http from 'node:http';

export type RoleCode = 'sales' | 'production' | 'purchasing' | 'owner' | 'admin';
export const ROLES: { code: RoleCode; label: string }[] = [
  { code: 'sales', label: '業務主管' }, { code: 'production', label: '生產主管' }, { code: 'purchasing', label: '採購主管' },
  { code: 'owner', label: '老闆' }, { code: 'admin', label: '管理員' }
];
/** 可被派發角色儀表板的角色（管理員不在內）。 */
export const ASSIGNABLE: RoleCode[] = ['sales', 'production', 'purchasing', 'owner'];
export function isRole(x: unknown): x is RoleCode { return ROLES.some((r) => r.code === x); }
export function viewerOf(req: http.IncomingMessage): RoleCode {
  const v = req.headers['x-viewer'];
  return isRole(v) ? v : 'sales';
}
