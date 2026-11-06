// 啟動：node server/index.ts（PORT 預設 3100，只綁 127.0.0.1；DATA_DIR 可改資料目錄）
import { join } from 'node:path';
import { createApp } from './app.ts';
import { DEMO_DB_PATH, openDemoDb } from './db.ts';
import { localToday } from './engine.ts';
import { createStore, SEED_PATH, STORE_PATH } from './store.ts';
import { CATALOG } from './topics.ts'; // 載入即驗證 topics.json，不通過就拒絕啟動

const dataDir = process.env.DATA_DIR;
const t0 = Date.now();
// 資料準備好才開始 listen，服務喚醒後的第一個請求不會碰到空資料
const demo = openDemoDb(dataDir ? join(dataDir, 'demo.db') : DEMO_DB_PATH, localToday());
const store = createStore(dataDir ? join(dataDir, 'store.json') : STORE_PATH, SEED_PATH);
const port = Number(process.env.PORT || 3100), host = process.env.HOST || '127.0.0.1';
createApp({ exec: demo.exec, store, asOf: demo.asOf }).listen(port, host, () => {
  console.log(`自助營運分析：http://${host}:${port}/  （主題：${Object.keys(CATALOG).join('、')}）`);
  console.log(`Demo 資料：${demo.regenerated ? '已重新產生' : '沿用既有資料庫'}，基準日 ${demo.asOf}（${Date.now() - t0} ms）`);
});
