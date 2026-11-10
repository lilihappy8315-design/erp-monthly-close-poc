/* 清洗：把 CSV 的文字列轉成乾淨的記錄，並把問題分成三級：
 *   block（需要你處理）：缺少必要計算欄位，列為待處理，不納入計算，不靜默補零、不硬合併
 *   auto （系統已自動處理）：有合理回推做法（例如單價空白用 金額÷數量），可抽查
 *   info （僅提醒）：不影響收入與成本，但可能影響逾期判斷等
 * 每一列保留 raw（目前的原始文字，可被使用者修正）與 orig（最初從檔案讀到的文字）。
 * 修正某欄後呼叫 cleanRecord 重新判定，不需要重讀檔案。
 */
(function (g) {
  const ERP = (g.ERP = g.ERP || {});

  const HEADERS = ["單據日期", "訂單單號", "客戶代號", "客戶名稱", "統一編號", "聯絡人", "聯絡電話", "Email",
    "送貨地址", "業務員", "品號", "品名", "數量", "單位", "單價", "單位成本", "未稅金額",
    "帳款到期日", "收款日期", "備註"];
  const KEYS = ["date", "orderNo", "custCode", "custName", "taxId", "contact", "phone", "email",
    "addr", "rep", "sku", "skuName", "qty", "unit", "price", "cost", "amount", "due", "paid", "remark"];
  const LABEL = Object.fromEntries(KEYS.map((k, i) => [k, HEADERS[i]]));

  // 全形 → 半形（含全形空白）
  function toHalf(s) {
    return String(s)
      .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .replace(/　/g, " ");
  }

  const pad = (n) => String(n).padStart(2, "0");

  // 日期：西元 2026/07/03、2026-07-03、20260703；民國 115/07/03。回傳 'YYYY-MM-DD'、null（空白）或 undefined（無法解析）
  function parseDate(raw) {
    const s = toHalf(raw == null ? "" : raw).trim();
    if (s === "") return null;
    let m = s.match(/^(\d{2,4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
    if (!m) {
      const c = s.match(/^(\d{4})(\d{2})(\d{2})$/);
      if (c) m = c;
    }
    if (!m) return undefined;
    let y = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10);
    const d = parseInt(m[3], 10);
    if (m[1].length <= 3) y += 1911; // 民國年
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return undefined;
    return `${y}-${pad(mo)}-${pad(d)}`;
  }

  // 數字：支援全形、千分位、前後空白。空白回傳 null，無法解析回傳 NaN
  function parseNum(raw) {
    const s = toHalf(raw == null ? "" : raw).replace(/[,\s]/g, "").replace(/^NT\$|^\$/i, "");
    if (s === "") return null;
    if (!/^-?\d+(\.\d+)?$/.test(s)) return NaN;
    return Number(s);
  }

  function text(raw) {
    return String(raw == null ? "" : raw).replace(/\s+/g, " ").trim();
  }

  function mapColumns(headerRow) {
    const names = headerRow.map((h) => text(h));
    const idx = HEADERS.map((h) => names.indexOf(h));
    const missing = HEADERS.filter((h, i) => idx[i] < 0);
    if (missing.length === 0) return { idx, warning: null };
    if (headerRow.length === 20) {
      return { idx: HEADERS.map((_, i) => i), warning: `欄名與預期不同（缺 ${missing.join("、")}），已改依欄位順序讀取，請確認匯出格式。` };
    }
    return { idx: null, error: `找不到必要欄位：${missing.join("、")}。此檔共 ${headerRow.length} 欄，預期 20 欄的「訂單明細」匯出檔。` };
  }

  // 問題代碼 → 等級與可修正的欄位
  const ISSUE_META = {
    date_blank: { level: "block", fields: ["date"] },
    date_bad: { level: "block", fields: ["date"] },
    tax_blank: { level: "block", fields: ["taxId"] },
    qty_bad: { level: "block", fields: ["qty"] },
    cost_bad: { level: "block", fields: ["cost"] },
    zero_qty_no_price: { level: "block", fields: ["qty", "price"] },
    price_amount_missing: { level: "block", fields: ["price", "amount"] },
    amount_unavailable: { level: "block", fields: ["amount"] },
    price_backfilled: { level: "auto", fields: ["price"] },
    amount_backfilled: { level: "auto", fields: ["amount"] },
    due_missing: { level: "info", fields: ["due"] },
    due_bad: { level: "info", fields: ["due"] },
    paid_bad: { level: "info", fields: ["paid"] },
    tax_format: { level: "info", fields: ["taxId"] },
  };

  // 以「目前的 raw 文字」重新清洗一列。raw 是 { date: '2026/07/03', ... } 形式。
  function cleanRecord(raw, line, idx) {
    const rec = { line, idx, issues: [], raw: { ...raw } };
    const add = (code, msg) => rec.issues.push({ code, level: ISSUE_META[code].level, fields: ISSUE_META[code].fields, msg });

    ["orderNo", "custCode", "custName", "contact", "phone", "email", "addr", "rep", "sku", "skuName", "unit", "remark"]
      .forEach((key) => (rec[key] = text(raw[key])));
    rec.taxId = toHalf(raw.taxId).replace(/\s+/g, "");

    const date = parseDate(raw.date);
    if (date === null) add("date_blank", "單據日期空白");
    else if (date === undefined) add("date_bad", `單據日期無法解析（原值：${text(raw.date)}）`);
    rec.date = date || null;
    const due = parseDate(raw.due);
    if (due === undefined) add("due_bad", `帳款到期日無法解析（原值：${text(raw.due)}），無法判斷逾期`);
    else if (due === null) add("due_missing", "帳款到期日空白，無法判斷是否逾期");
    rec.due = due || null;
    const paid = parseDate(raw.paid);
    if (paid === undefined) add("paid_bad", `收款日期無法解析（原值：${text(raw.paid)}），視為未收`);
    rec.paid = paid || null;

    if (rec.taxId === "") add("tax_blank", "統一編號空白，無法判定是哪一家法人");
    else if (!/^\d{8}$/.test(rec.taxId)) add("tax_format", "統一編號不是 8 碼數字（仍以該號碼合併，不刪除）");

    const qty = parseNum(raw.qty);
    const cost = parseNum(raw.cost);
    let price = parseNum(raw.price);
    let amount = parseNum(raw.amount);
    if (qty === null || Number.isNaN(qty)) add("qty_bad", "數量空白或無法解析");
    if (cost === null || Number.isNaN(cost)) add("cost_bad", "單位成本空白或無法解析");
    if (Number.isNaN(price)) price = null;
    if (Number.isNaN(amount)) amount = null;

    // 供畫面顯示「這列約影響多少收入」（只用於本機畫面）
    let impact = amount;
    if (impact == null && qty != null && !Number.isNaN(qty) && price != null) impact = qty * price;
    rec.impact = impact;

    if (qty !== null && !Number.isNaN(qty)) {
      if (amount === null && price !== null) {
        amount = Math.round(qty * price * 100) / 100;
        add("amount_backfilled", "未稅金額空白，已用 數量×單價 回推");
        rec.backfill = { field: "amount", value: amount };
      }
      if (price === null) {
        if (qty === 0) add("zero_qty_no_price", "數量為 0 且單價空白，無法回推單價");
        else if (amount !== null) {
          price = amount / qty;
          add("price_backfilled", "單價空白，已用 未稅金額÷數量 回推");
          rec.backfill = { field: "price", value: price };
        } else add("price_amount_missing", "單價與未稅金額都空白");
      }
      if (amount === null && !rec.issues.some((i) => i.level === "block")) add("amount_unavailable", "未稅金額無法取得");
    }
    rec.qty = qty;
    rec.cost = cost;
    rec.price = price;
    rec.amount = amount;

    rec.problems = rec.issues.filter((i) => i.level === "block").map((i) => i.msg);
    rec.notes = rec.issues.filter((i) => i.level !== "block").map((i) => i.msg);
    rec.status = rec.problems.length ? "pending" : "ok";
    return rec;
  }

  // 重新判定一列（修正某欄之後）。保留 orig / edits / excluded 等人工處理資訊。
  function reclean(rec) {
    const n = cleanRecord(rec.raw, rec.line, rec.idx);
    n.orig = rec.orig;
    n.edits = rec.edits || [];
    n.excluded = !!rec.excluded;
    if (n.status === "pending" && n.excluded) n.status = "excluded";
    if (n.status === "ok") n.excluded = false; // 已經修好，不需要「不納入」
    return n;
  }

  function cleanRows(rows) {
    if (!rows.length) return { error: "檔案是空的，請確認選到的是 ERP 匯出的 CSV。" };
    const map = mapColumns(rows[0]);
    if (map.error) return { error: map.error };

    const records = [];
    const body = rows.slice(1);
    body.forEach((cells, k) => {
      const raw = {};
      KEYS.forEach((key, i) => (raw[key] = cells[map.idx[i]] == null ? "" : cells[map.idx[i]]));
      const rec = cleanRecord(raw, k + 2, k);
      rec.orig = { ...raw };
      rec.edits = [];
      rec.excluded = false;
      records.push(rec);
    });
    return { records, warning: map.warning || null, rowCount: body.length };
  }

  // 欄位修正前的格式檢查：回傳錯誤說明，通過則回傳 null
  function validateInput(field, value) {
    const v = String(value).trim();
    if (["date", "due", "paid"].includes(field)) {
      if (v === "" && field !== "date") return null;
      const d = parseDate(v);
      if (d === null || d === undefined) return "日期格式不正確，請輸入例如 2026/07/03 或 115/07/03";
      return null;
    }
    if (field === "taxId") return /^\d{8}$/.test(toHalf(v).replace(/\s+/g, "")) ? null : "統一編號需為 8 碼數字";
    if (["qty", "price", "cost", "amount"].includes(field)) {
      const n = parseNum(v);
      if (n === null || Number.isNaN(n)) return "請輸入數字";
      if ((field === "price" || field === "cost") && n < 0) return "不能是負數";
      return null;
    }
    return null;
  }

  ERP.clean = { HEADERS, KEYS, LABEL, ISSUE_META, toHalf, parseDate, parseNum, cleanRecord, reclean, cleanRows, validateInput };
  if (typeof module === "object" && module.exports) module.exports = ERP.clean;
})(typeof globalThis !== "undefined" ? globalThis : this);
