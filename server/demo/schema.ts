// Demo 資料庫結構。日期欄一律存 YYYY-MM-DD 文字；改結構時要加大 SCHEMA_VERSION，舊檔案下次啟動會重建。
export const SCHEMA_VERSION = 1;

export const DDL = `
CREATE TABLE demo_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE customers(id INTEGER PRIMARY KEY, short_name TEXT NOT NULL);
CREATE TABLE suppliers(id INTEGER PRIMARY KEY, short_name TEXT NOT NULL);
CREATE TABLE urgency_types(code TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE sales_orders(
  id INTEGER PRIMARY KEY, order_no TEXT NOT NULL, customer_id INTEGER NOT NULL, order_date TEXT NOT NULL, due_date TEXT, factory_due TEXT,
  salesperson TEXT, order_type TEXT, urgency TEXT, currency TEXT NOT NULL, exchange_rate REAL NOT NULL, total_amount REAL NOT NULL,
  status TEXT NOT NULL -- open／closed／cancelled
);
CREATE TABLE sales_order_lines(
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL, item_no TEXT, part_no TEXT, part_name TEXT, qty REAL NOT NULL, unit TEXT,
  unit_price REAL, amount REAL NOT NULL, due_date TEXT
);
CREATE TABLE shipments(id INTEGER PRIMARY KEY, ship_no TEXT NOT NULL, customer_id INTEGER NOT NULL, ship_date TEXT NOT NULL, currency TEXT NOT NULL, exchange_rate REAL NOT NULL);
CREATE TABLE shipment_lines(id INTEGER PRIMARY KEY, shipment_id INTEGER NOT NULL, order_line_id INTEGER NOT NULL, qty REAL NOT NULL, unit TEXT, amount REAL NOT NULL);
CREATE TABLE job_parts(id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL, part_no TEXT, part_name TEXT, done INTEGER NOT NULL);
CREATE TABLE machines(id INTEGER PRIMARY KEY, machine_no TEXT NOT NULL, machine_group TEXT, capacity_hours REAL NOT NULL, retired_date TEXT);
CREATE TABLE processes(
  id INTEGER PRIMARY KEY, job_part_id INTEGER NOT NULL, order_id INTEGER NOT NULL, seq TEXT NOT NULL, process_name TEXT, machine_id INTEGER,
  is_outsourced INTEGER NOT NULL, status TEXT NOT NULL, -- not_started／ready／running／paused／done
  start_date TEXT, end_date TEXT, qty REAL
);
CREATE TABLE work_calendar(work_date TEXT PRIMARY KEY, is_workday INTEGER NOT NULL);
CREATE TABLE report_categories(code TEXT PRIMARY KEY, name TEXT NOT NULL, counts_as_run INTEGER NOT NULL);
CREATE TABLE work_reports(
  id INTEGER PRIMARY KEY, process_id INTEGER, machine_id INTEGER NOT NULL, order_no TEXT, part_no TEXT, report_date TEXT NOT NULL,
  status TEXT, category_code TEXT NOT NULL, shift TEXT, run_hours REAL NOT NULL, qty_done REAL
);
CREATE TABLE purchase_orders(id INTEGER PRIMARY KEY, po_no TEXT NOT NULL, supplier_id INTEGER NOT NULL, order_date TEXT NOT NULL, purchase_type TEXT, currency TEXT NOT NULL, exchange_rate REAL NOT NULL);
CREATE TABLE purchase_lines(
  id INTEGER PRIMARY KEY, po_id INTEGER NOT NULL, item_no TEXT, due_date TEXT, part_no TEXT, part_name TEXT, spec TEXT, job_no TEXT, tool_no TEXT,
  unit TEXT, qty REAL NOT NULL, unit_price REAL, amount REAL NOT NULL, closed INTEGER NOT NULL
);
CREATE TABLE receipts(id INTEGER PRIMARY KEY, receipt_no TEXT NOT NULL, supplier_id INTEGER NOT NULL, receipt_date TEXT NOT NULL, bill_month TEXT, currency TEXT NOT NULL);
CREATE TABLE receipt_lines(
  id INTEGER PRIMARY KEY, receipt_id INTEGER NOT NULL, purchase_line_id INTEGER NOT NULL, part_no TEXT, part_name TEXT, tool_no TEXT, job_no TEXT,
  qty REAL NOT NULL, unit TEXT, qc_result TEXT
);
`;

export const INDEXES = `
CREATE INDEX ix_order_lines_order ON sales_order_lines(order_id);
CREATE INDEX ix_orders_date ON sales_orders(order_date);
CREATE INDEX ix_ship_lines_line ON shipment_lines(order_line_id);
CREATE INDEX ix_ship_lines_ship ON shipment_lines(shipment_id);
CREATE INDEX ix_processes_part ON processes(job_part_id);
CREATE INDEX ix_reports_process ON work_reports(process_id);
CREATE INDEX ix_reports_machine ON work_reports(machine_id, report_date);
CREATE INDEX ix_po_lines_po ON purchase_lines(po_id);
CREATE INDEX ix_receipt_lines_line ON receipt_lines(purchase_line_id);
CREATE INDEX ix_receipt_lines_receipt ON receipt_lines(receipt_id);
`;
