# 後端

`server/`：Node 22 原生執行 TypeScript，`node:http`＋內建 `node:sqlite`，執行期零相依。

| 檔案 | 職責 |
|---|---|
| `index.ts` | 進入點：資料就緒後才 listen |
| `app.ts` | HTTP 路由、請求與儲存上限 |
| `db.ts` | 開啟 Demo 資料庫：不存在、損壞或版本不符就重新產生；查詢端唯讀 |
| `demo/schema.ts`、`demo/generate.ts` | 資料表結構與可重現的資料產生器 |
| `topics.ts` | 載入 `config/topics.json` 欄位目錄 |
| `engine.ts` | 不碰資料的規則：日期區間、條件與定義驗證、widget 狀態 |
| `sqlgen.ts` | 由報表定義產生參數化 SQL |
| `guard.ts` | SQL 白名單檢查：只允許單一 `SELECT` |
| `service.ts` | 驗證 → 產生 SQL → 執行 → 組成回應 |
| `cache.ts` | 10 分鐘查詢結果快取 |
| `store.ts` | 報表、儀表板與角色首頁的 JSON 儲存 |
| `viewer.ts` | 由 `X-Viewer` header 解析模擬身分 |

## API

所有請求帶 `X-Viewer: sales|production|purchasing|owner|admin`。

| 方法與路徑 | 用途 |
|---|---|
| `GET /api/health` | 健康檢查 |
| `GET /api/meta` | 欄位目錄、選項、基準日（`asOf`） |
| `GET /api/state` | 目前身分看得到的報表、儀表板與首頁 |
| `POST /api/run` | 執行報表（body：`{ def }`） |
| `POST /api/chart` | 計算圖表卡片 |
| `POST /api/drill` | 下鑽明細 |
| `POST /api/chart-options` | 可用圖表類型與不可用原因 |
| `GET/POST /api/reports`、`GET/PUT/DELETE /api/reports/:id` | 報表 CRUD |
| `GET/POST /api/dashboards`、`GET/PUT/DELETE /api/dashboards/:id` | 儀表板 CRUD |
| `POST /api/dashboards/:id/restore` | 個人版還原成角色預設 |
| `PUT /api/role-home` | 設定角色首頁（管理員） |
| `POST /api/reset` | 還原初始內容（管理員） |

`X-Refresh: 1` 讓查詢略過快取，每人每分鐘一次。

錯誤：業務錯誤回 `ok: false`；超過數量上限 409（`LIMIT_REACHED`）、單項過大 400、請求過大 413。

## SQL 形狀

- 所有欄位運算式來自 `config/topics.json`，使用者只能選欄位 id。
- 使用者輸入一律走具名參數；`@today` 是資料基準日。
- 日期存成 `YYYY-MM-DD` 文字。週分組的鍵是該週週一，月分組的鍵是 `YYYY-MM`。
- 明細多取 1 筆判斷截斷，截斷時另跑 `COUNT` 回真實筆數。

## 測試

`npm test` 用 `node:test`。`topics.sqlite.test.ts` 與 `asof.test.ts` 對真實 SQLite 跑，並和產生器獨立累計的 `DemoTruth` 對帳；`asof.test.ts` 也驗證子行程開機與 4 個角色首頁都有資料。
