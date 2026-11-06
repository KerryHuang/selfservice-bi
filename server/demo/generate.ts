// Demo 資料產生器：以 today 為基準往前 730 天，同一個 today 內容完全相同。所有名稱都是虛構的。
import type { DatabaseSync } from 'node:sqlite';
import { INDEXES } from './schema.ts';

export interface DemoTruth {
  orderLines: number;
  amountLocalByCustomer: Record<string, number>;
  dueStatusCounts: Record<string, number>;
  /** 計入稼動的機時與應有產能（到 today 為止）。 */
  runHours: number; capacityHours: number;
  machineUtilization: Record<string, number>;
  supplierDeliveryCounts: Record<string, number>;
  supplierOnTimeRate: Record<string, number>;
  backlogCounts: Record<string, number>;
  idleProcesses: number;
}

const SPAN_DAYS = 730, ORDERS = 2880, PURCHASE_ORDERS = 1440, MACHINES = 40;
const FX: Record<string, number> = { TWD: 1, JPY: 0.21, USD: 32.5 };
const CUSTOMER_PREFIX = ['北辰', '南澄', '東岳', '西澤', '青峰', '白川', '明遠', '恆新', '瑞豐', '宏岳'];
const CUSTOMER_SUFFIX = ['精密', '工業', '電子'];
const SUPPLIERS = ['青禾', '遠鋒', '泰昇', '聚林', '磐石', '森川', '光海', '合瀚', '金澤', '和泰', '永曜', '天衡'];
const SUPPLIER_KIND = ['材料', '鋼材', '五金', '包材'];
const BAD_CUSTOMERS = new Set([3, 7]), BAD_SUPPLIERS = new Set([2, 9]); // 故事：這幾家交期明顯較差
const BUSY_MACHINES = new Set([1, 2]), IDLE_MACHINES = new Set([39, 40]);
const PARTS = ['外殼', '齒輪', '蓋板', '支架', '旋鈕', '底座', '端蓋', '導軌', '卡榫', '面板'];
const MATERIALS = ['工程塑膠粒', '色母', '模具鋼', '頂針', '彈簧', '紙箱', '潤滑油', '刀具'];
const PROCESS_STEPS: { name: string; group: string | null }[] = [
  { name: '射出', group: '射出 A' }, { name: '二次射出', group: '射出 B' }, { name: '修邊', group: '加工' },
  { name: '鑽孔', group: '加工' }, { name: '組裝', group: '後段' }, { name: '檢驗', group: '後段' }
];
const OUTSOURCE_STEPS = ['電鍍', '表面處理'];

function rngFrom(seed: number): () => number {
  return () => { // mulberry32
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const addDays = (s: string, n: number): string => {
  const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const dayOfWeek = (s: string): number => new Date(s + 'T00:00:00Z').getUTCDay();
const money = (n: number): number => Math.round(n * 100) / 100;
const pad = (n: number, w: number): string => String(n).padStart(w, '0');
const bump = (o: Record<string, number>, k: string, n = 1): void => { o[k] = (o[k] || 0) + n; };

interface Proc {
  id: number; partId: number; orderIdx: number; seq: number; name: string; machineId: number | null; outsourced: boolean;
  status: 'not_started' | 'ready' | 'running' | 'paused' | 'done'; plannedStart: string; plannedEnd: string; stuck: boolean; qty: number;
}
const BACKLOG: Record<string, string> = { not_started: '未開工', ready: '準備開工', running: '開工中', paused: '暫停' };

export function generateDemo(db: DatabaseSync, today: string): DemoTruth {
  const rnd = rngFrom(20261106);
  const int = (a: number, b: number): number => a + Math.floor(rnd() * (b - a + 1));
  const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)];
  const start = addDays(today, -SPAN_DAYS);
  const truth: DemoTruth = {
    orderLines: 0, amountLocalByCustomer: {}, dueStatusCounts: {}, runHours: 0, capacityHours: 0, machineUtilization: {},
    supplierDeliveryCounts: {}, supplierOnTimeRate: {}, backlogCounts: {}, idleProcesses: 0
  };

  db.exec('BEGIN');

  /* ---------- 主檔 ---------- */
  const customers = CUSTOMER_PREFIX.flatMap((p) => CUSTOMER_SUFFIX.map((s) => p + '示範' + s));
  const suppliers = SUPPLIERS.map((p, i) => p + '示範' + SUPPLIER_KIND[i % SUPPLIER_KIND.length]);
  const insCustomer = db.prepare('INSERT INTO customers VALUES (?, ?)');
  customers.forEach((n, i) => insCustomer.run(i + 1, n));
  const insSupplier = db.prepare('INSERT INTO suppliers VALUES (?, ?)');
  suppliers.forEach((n, i) => insSupplier.run(i + 1, n));
  db.exec("INSERT INTO urgency_types VALUES ('N', '一般'), ('H', '優先'), ('U', '急件')");
  db.exec(`INSERT INTO report_categories VALUES ('RUN', '正常生產', 1), ('REWORK', '返修', 1), ('SETUP', '架模換線', 0), ('FAULT', '設備故障', 0), ('MAINT', '保養', 0)`);

  const groups = ['射出 A', '射出 B', '加工', '後段'];
  const machines: { id: number; no: string; group: string; capacity: number; factor: number }[] = [];
  const machinesByGroup = new Map<string, number[]>(groups.map((g) => [g, []]));
  const insMachine = db.prepare('INSERT INTO machines VALUES (?, ?, ?, ?, NULL)');
  for (let id = 1; id <= MACHINES; id++) {
    const group = groups[(id - 1) % groups.length], capacity = id % 5 < 2 ? 24 : 16;
    const factor = BUSY_MACHINES.has(id) ? 0.97 : IDLE_MACHINES.has(id) ? 0.3 : 0.55 + rnd() * 0.25;
    const no = 'M' + pad(id, 2);
    machines.push({ id, no, group, capacity, factor });
    machinesByGroup.get(group)!.push(id);
    insMachine.run(id, no, group, capacity);
  }

  /* ---------- 訂單、出貨、工令 ---------- */
  const insOrder = db.prepare('INSERT INTO sales_orders VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const insLine = db.prepare('INSERT INTO sales_order_lines VALUES (?,?,?,?,?,?,?,?,?,?)');
  const insShip = db.prepare('INSERT INTO shipments VALUES (?,?,?,?,?,?)');
  const insShipLine = db.prepare('INSERT INTO shipment_lines VALUES (?,?,?,?,?,?)');
  const insPart = db.prepare('INSERT INTO job_parts VALUES (?,?,?,?,?)');
  let lineId = 0, shipId = 0, shipLineId = 0, partId = 0, procId = 0;
  const procs: Proc[] = [];
  const orderNos: string[] = [];
  const orderOpen: boolean[] = [];
  const parts: { id: number; orderIdx: number; no: string; name: string; procs: Proc[] }[] = [];

  for (let o = 1; o <= ORDERS; o++) {
    const orderDate = addDays(start, Math.round(((o - 1) / (ORDERS - 1)) * SPAN_DAYS));
    const headerDue = addDays(orderDate, int(14, 60));
    const custIdx = Math.floor(rnd() * rnd() * customers.length), custId = custIdx + 1;
    const currency = rnd() < 0.8 ? 'TWD' : pick(['JPY', 'USD']), fx = FX[currency];
    const cancelled = rnd() < 0.02;
    const orderNo = 'SO' + pad(o, 6);
    orderNos[o] = orderNo;
    const lineCount = int(1, 6);
    let total = 0, allShipped = true, allDone = true;
    for (let k = 1; k <= lineCount; k++) {
      const partIdx = int(1, 120), partNo = 'P-' + pad(1000 + partIdx, 4), partName = PARTS[partIdx % PARTS.length] + ' ' + String.fromCharCode(65 + partIdx % 6) + ' 型';
      const qty = int(100, 5000), price = money(rnd() * 50), amount = money(qty * price), unit = rnd() < 0.92 ? 'PCS' : 'SET';
      const lineDue = rnd() < 0.8 ? addDays(headerDue, int(0, 5)) : null, due = lineDue ?? headerDue;
      lineId++; total += amount;
      insLine.run(lineId, o, String(k), partNo, partName, qty, unit, price, amount, lineDue);

      /* 出貨 */
      const lateProb = BAD_CUSTOMERS.has(custIdx) ? 0.3 : 0.12;
      const late = rnd() < lateProb;
      const planned = late ? addDays(due, int(1, 12)) : addDays(due, -int(0, 6));
      const neverShip = rnd() < 0.015;
      const twoShips = rnd() < 0.2;
      let firstShip: string | null = null, shippedQty = 0;
      if (!cancelled && !neverShip && planned <= today) {
        const ship = (date: string, q: number): void => {
          shipId++; shipLineId++;
          insShip.run(shipId, 'SH' + pad(shipId, 6), custId, date, currency, fx);
          insShipLine.run(shipLineId, shipId, lineId, q, unit, money(q * price));
          shippedQty += q;
        };
        firstShip = planned;
        if (twoShips) {
          const firstQty = Math.ceil(qty * 0.6), second = addDays(planned, int(1, 5));
          ship(planned, firstQty);
          if (second <= today) ship(second, qty - firstQty);
        } else ship(planned, qty);
      }
      if (shippedQty < qty) allShipped = false;
      if (!cancelled) {
        truth.orderLines++;
        bump(truth.amountLocalByCustomer, customers[custIdx], Math.round(amount * fx));
        bump(truth.dueStatusCounts, firstShip == null ? (due >= today ? '未到期' : '逾期未交') : firstShip < due ? '提早' : firstShip === due ? '如期' : '延誤');
      }

      /* 工令零件與製程（已取消的訂單不排工） */
      if (cancelled) continue;
      partId++;
      const part = { id: partId, orderIdx: o, no: partNo, name: partName, procs: [] as Proc[] };
      parts.push(part);
      let cursor = addDays(orderDate, int(0, 3));
      const stepCount = int(2, 5), recent = orderDate >= addDays(today, -120);
      for (let seq = 1; seq <= stepCount; seq++) {
        const outsourced = rnd() < 0.1, step = pick(PROCESS_STEPS);
        const name = outsourced ? pick(OUTSOURCE_STEPS) : step.name;
        const machineId = outsourced ? null : pick(machinesByGroup.get(step.group!)!);
        const plannedStart = cursor, plannedEnd = addDays(cursor, int(1, 4));
        cursor = addDays(plannedEnd, 1);
        const stuck = !outsourced && recent && plannedEnd <= today && rnd() < 0.012;
        let status: Proc['status'];
        if (stuck) status = 'paused';
        else if (plannedEnd <= today) status = 'done';
        else if (plannedStart > today) status = rnd() < 0.7 ? 'not_started' : 'ready';
        else status = rnd() < 0.7 ? 'running' : 'paused';
        if (status !== 'done') allDone = false;
        const p: Proc = { id: ++procId, partId, orderIdx: o, seq, name, machineId, outsourced, status, plannedStart, plannedEnd, stuck, qty };
        procs.push(p); part.procs.push(p);
      }
    }
    const status = cancelled ? 'cancelled' : allShipped && allDone ? 'closed' : 'open';
    orderOpen[o] = status === 'open';
    insOrder.run(o, orderNo, custId, orderDate, headerDue, addDays(headerDue, -3), pick(['業務甲', '業務乙', '業務丙', '業務丁']), pick(['量產', '量產', '量產', '試作', '修護']), pick(['N', 'N', 'N', 'H', 'U']), currency, fx, money(total), status);
  }

  const insProc = db.prepare('INSERT INTO processes VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  for (const p of procs) {
    const started = p.status === 'done' || p.status === 'running' || p.status === 'paused';
    insProc.run(p.id, p.partId, p.orderIdx, String(p.seq * 10), p.name, p.machineId, p.outsourced ? 1 : 0, p.status, started ? p.plannedStart : null, p.status === 'done' ? p.plannedEnd : null, p.qty);
    if (!p.outsourced && orderOpen[p.orderIdx] && p.status !== 'done') bump(truth.backlogCounts, BACKLOG[p.status]);
  }
  for (const part of parts) insPart.run(part.id, part.orderIdx, part.no, part.name, part.procs.every((p) => p.status === 'done') ? 1 : 0);

  /* ---------- 日曆與報工 ---------- */
  const partById = new Map(parts.map((x) => [x.id, x]));
  const insCal = db.prepare('INSERT INTO work_calendar VALUES (?, ?)');
  const insReport = db.prepare('INSERT INTO work_reports VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  const lastReport = new Map<number, string>();
  const machineRun = new Map<number, number>(), machineCap = new Map<number, number>();
  let reportId = 0;
  const report = (p: Proc | null, machineId: number, date: string, category: string, shift: string, hours: number): void => {
    const counted = category === 'RUN' || category === 'REWORK';
    const part = p ? partById.get(p.partId)! : null;
    insReport.run(++reportId, p?.id ?? null, machineId, p ? orderNos[p.orderIdx] : null, part?.no ?? null, date, pick(['加工中', '加工中', '完工', '暫停']), category, shift, hours, int(0, 500));
    if (counted) { truth.runHours += hours; machineRun.set(machineId, (machineRun.get(machineId) || 0) + hours); }
    if (p && (!lastReport.has(p.id) || lastReport.get(p.id)! < date)) lastReport.set(p.id, date);
  };
  // 每台機台依開工日排序的可報工製程；暫停與卡住的製程只在開工當天報一筆，所以會「久未動」
  const byMachine = new Map<number, Proc[]>(machines.map((m) => [m.id, []]));
  for (const p of procs) {
    if (p.machineId == null || p.status === 'not_started' || p.status === 'ready') continue;
    if (p.status === 'paused') report(p, p.machineId, p.plannedStart, 'RUN', '正班', 2 + rnd() * 4);
    else byMachine.get(p.machineId)!.push(p);
  }
  const pointer = new Map<number, number>(machines.map((m) => [m.id, -1]));
  for (let d = start; d <= today; d = addDays(d, 1)) {
    const dow = dayOfWeek(d), workday = dow !== 0 && dow !== 6;
    insCal.run(d, workday ? 1 : 0);
    for (const m of machines) {
      if (workday) { truth.capacityHours += m.capacity; machineCap.set(m.id, (machineCap.get(m.id) || 0) + m.capacity); }
      else if (dow !== 6 || rnd() > 0.03) continue; // 週六偶爾加班
      const list = byMachine.get(m.id)!;
      let i = pointer.get(m.id)!;
      while (i + 1 < list.length && list[i + 1].plannedStart <= d) i++;
      pointer.set(m.id, i);
      const proc = i >= 0 ? list[i] : null;
      const target = workday ? m.capacity * m.factor * (0.85 + rnd() * 0.3) : 4 + rnd() * 4;
      const pieces = int(1, 3);
      for (let k = 0; k < pieces; k++) {
        const shift = !workday ? '假日加班' : k === 0 ? '正班' : pick(['加班', '夜班']);
        report(proc, m.id, d, rnd() < 0.9 ? 'RUN' : 'REWORK', shift, Math.round((target / pieces) * 100) / 100);
      }
      if (rnd() < 0.15) report(proc, m.id, d, pick(['SETUP', 'FAULT', 'MAINT']), '正班', Math.round((0.5 + rnd() * 1.5) * 100) / 100);
    }
  }
  for (const m of machines) truth.machineUtilization[m.no] = ((machineRun.get(m.id) || 0) * 100) / (machineCap.get(m.id) || 1);
  const staleBefore = addDays(today, -7);
  for (const p of procs) {
    if (p.outsourced || p.status === 'done' || !orderOpen[p.orderIdx]) continue;
    const last = lastReport.get(p.id);
    if (last && last <= staleBefore) truth.idleProcesses++;
  }

  /* ---------- 採購與收料 ---------- */
  const insPo = db.prepare('INSERT INTO purchase_orders VALUES (?,?,?,?,?,?,?)');
  const insPoLine = db.prepare('INSERT INTO purchase_lines VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const insReceipt = db.prepare('INSERT INTO receipts VALUES (?,?,?,?,?,?)');
  const insReceiptLine = db.prepare('INSERT INTO receipt_lines VALUES (?,?,?,?,?,?,?,?,?,?)');
  let poLineId = 0, receiptId = 0, receiptLineId = 0;
  const supOnTime: Record<string, number> = {}, supLate: Record<string, number> = {};
  for (let po = 1; po <= PURCHASE_ORDERS; po++) {
    const orderDate = addDays(start, Math.round(((po - 1) / (PURCHASE_ORDERS - 1)) * SPAN_DAYS));
    const supIdx = Math.floor(rnd() * suppliers.length), supId = supIdx + 1, name = suppliers[supIdx];
    const currency = rnd() < 0.85 ? 'TWD' : 'USD';
    insPo.run(po, 'PO' + pad(po, 6), supId, orderDate, pick(['原料', '原料', '模治具', '耗材']), currency, FX[currency]);
    const count = int(1, 5);
    for (let k = 1; k <= count; k++) {
      const due = addDays(orderDate, int(7, 45)), qty = int(10, 2000), price = money(1 + rnd() * 80), amount = money(qty * price), unit = rnd() < 0.7 ? 'KG' : 'PCS';
      const material = pick(MATERIALS), partNo = 'M-' + pad(int(100, 260), 4), toolNo = rnd() < 0.3 ? 'T-' + pad(int(1, 60), 3) : null, jobNo = rnd() < 0.5 ? orderNos[int(1, ORDERS)] : null;
      const late = rnd() > (BAD_SUPPLIERS.has(supIdx) ? 0.6 : 0.95);
      const finalDate = late ? addDays(due, int(1, 15)) : addDays(due, -int(0, 5));
      const r = rnd(), shortClosed = r < 0.01, neverArrive = r >= 0.01 && r < 0.025;
      poLineId++;
      const lineNo = poLineId;
      const receive = (date: string, q: number): void => {
        receiptId++; receiptLineId++;
        insReceipt.run(receiptId, 'RC' + pad(receiptId, 6), supId, date, date.slice(0, 7), currency);
        insReceiptLine.run(receiptLineId, receiptId, lineNo, partNo, material, toolNo, jobNo, q, unit, pick(['合格', '合格', '合格', '合格', '特採', '待驗']));
      };
      let received = 0, lastDate: string | null = null;
      if (shortClosed) {
        if (finalDate <= today) { const q = Math.ceil(qty * 0.7); receive(finalDate, q); received = q; lastDate = finalDate; }
      } else if (!neverArrive) {
        const split = rnd() < 0.15;
        if (split) {
          const firstDate = addDays(finalDate, -int(1, 6)), q = Math.ceil(qty * 0.6);
          if (firstDate <= today) { receive(firstDate, q); received = q; lastDate = firstDate; }
          if (finalDate <= today) { receive(finalDate, qty - q); received = qty; lastDate = finalDate; }
        } else if (finalDate <= today) { receive(finalDate, qty); received = qty; lastDate = finalDate; }
      }
      const full = received >= qty;
      const closed = shortClosed && lastDate != null ? 1 : full ? 1 : 0;
      insPoLine.run(lineNo, po, String(k), due, partNo, material, '規格 ' + int(1, 9), jobNo, toolNo, unit, qty, price, amount, closed);
      let state: string;
      if (full) { state = lastDate! <= due ? '準時' : '延誤'; if (state === '準時') supOnTime[name] = (supOnTime[name] || 0) + 1; else supLate[name] = (supLate[name] || 0) + 1; }
      else if (closed) state = '結案未收齊';
      else state = due < today ? '逾期未到' : '未到期';
      bump(truth.supplierDeliveryCounts, state);
    }
  }
  for (const n of suppliers) truth.supplierOnTimeRate[n] = ((supOnTime[n] || 0) * 100) / ((supOnTime[n] || 0) + (supLate[n] || 0) || 1);

  db.exec('COMMIT');
  db.exec(INDEXES);
  db.exec('ANALYZE');
  return truth;
}
