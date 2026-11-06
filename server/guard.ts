// SQL 守衛：送出前最後一道檢查。只放行單一 SELECT 陳述式。
const FORBIDDEN = [
  'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'DROP', 'ALTER', 'CREATE', 'EXEC', 'EXECUTE', 'TRUNCATE', 'GRANT', 'REVOKE',
  'DENY', 'BACKUP', 'RESTORE', 'SHUTDOWN', 'DBCC', 'OPENROWSET', 'OPENQUERY'
];
const FORBIDDEN_RE = new RegExp('\\b(?:' + FORBIDDEN.join('|') + ')\\b|\\bxp_', 'i');

export class SqlGuardError extends Error {}

/** 片段（from／where／欄位運算式…）：不得含分號、註解標記與危險關鍵字。 */
export function assertSafeFragment(sql: string, label = 'SQL'): void {
  if (sql.includes(';')) throw new SqlGuardError(label + ' 含分號');
  if (sql.includes('--') || sql.includes('/*') || sql.includes('*/')) throw new SqlGuardError(label + ' 含註解標記');
  const m = FORBIDDEN_RE.exec(sql);
  if (m) throw new SqlGuardError(label + ' 含禁用字詞：' + m[0]);
}

/** 完整陳述式：必須以 SELECT 開頭，再加上片段規則。 */
export function assertSafeSelect(sql: string): void {
  if (!/^\s*SELECT\b/i.test(sql)) throw new SqlGuardError('只允許 SELECT 開頭的陳述式');
  assertSafeFragment(sql, '陳述式');
}
