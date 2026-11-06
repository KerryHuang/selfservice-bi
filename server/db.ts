// Demo 資料庫：啟動時開啟 data/demo.db；不存在、損壞或版本不符就重新產生。查詢端以唯讀模式連線，送出前再過一次 SELECT 守衛。
import { mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { DDL, SCHEMA_VERSION } from './demo/schema.ts';
import { generateDemo } from './demo/generate.ts';
import { assertSafeSelect } from './guard.ts';
import { ServiceError } from './service.ts';
import type { Exec, Row } from './service.ts';
import type { Built } from './sqlgen.ts';

export const DEMO_DB_PATH = fileURLToPath(new URL('../data/demo.db', import.meta.url));

export interface DemoDb { exec: Exec; asOf: string; regenerated: boolean; close(): void }

/** 檔案可用時回傳資料基準日；不存在或有任何問題都回 null。 */
function readUsableAsOf(path: string): string | null {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const check = db.prepare('PRAGMA quick_check(1)').get() as { quick_check?: string } | undefined;
    if (check?.quick_check !== 'ok') return null;
    const meta = new Map((db.prepare('SELECT key, value FROM demo_meta').all() as { key: string; value: string }[]).map((r) => [r.key, r.value]));
    if (meta.get('schema_version') !== String(SCHEMA_VERSION)) return null;
    return meta.get('generated_on') ?? null;
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* 開啟失敗時沒有東西要關 */ }
  }
}

/** 先寫暫存檔，完成後才 rename，當機時不會留下半個資料庫。 */
function buildDb(path: string, today: string): void {
  const tmp = path + '.tmp';
  mkdirSync(dirname(path), { recursive: true });
  rmSync(tmp, { force: true });
  const db = new DatabaseSync(tmp);
  try {
    db.exec('PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;');
    db.exec(DDL);
    const meta = db.prepare('INSERT INTO demo_meta VALUES (?, ?)');
    meta.run('schema_version', String(SCHEMA_VERSION));
    meta.run('generated_on', today);
    generateDemo(db, today);
  } finally {
    db.close();
  }
  renameSync(tmp, path);
}

export function openDemoDb(path: string, today: string): DemoDb {
  let asOf = readUsableAsOf(path);
  const regenerated = asOf == null;
  if (asOf == null) {
    rmSync(path, { force: true });
    buildDb(path, today);
    asOf = today;
  }
  rmSync(path + '.tmp', { force: true });
  const db = new DatabaseSync(path, { readOnly: true });
  const exec: Exec = async (q: Built): Promise<Row[]> => {
    assertSafeSelect(q.text);
    try {
      const args: Record<string, string | number> = {};
      // node:sqlite 不接受語句沒用到的具名參數
      for (const p of q.params) if (new RegExp('@' + p.name + '\\b').test(q.text)) args[p.name] = p.value;
      return db.prepare(q.text).all(args) as Row[];
    } catch (e) {
      throw new ServiceError('DB_ERROR', '資料庫執行錯誤：' + String((e as Error).message).slice(0, 300), 500);
    }
  };
  return { exec, asOf, regenerated, close: () => db.close() };
}
