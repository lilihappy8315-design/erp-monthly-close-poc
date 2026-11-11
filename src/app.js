/* 畫面層。所有資料只存在這個分頁的記憶體裡（不使用 localStorage / cookie / 任何網路）。
 * 所有來自資料或使用者貼上的文字，一律用 textContent / createTextNode 顯示，絕不使用 innerHTML。
 */
(function () {
  "use strict";
  const { parseCSV, stringifyCSV } = ERP.csv;
  const { cleanRows, reclean, validateInput, HEADERS, KEYS, LABEL } = ERP.clean;
  const { compute, defaultBaseDate } = ERP.calc;
  const { buildMapping, buildPack, selfCheck, restore } = ERP.pseudo;
  const { STEPS, nextStep } = ERP.guide;

  const $ = (id) => document.getElementById(id);
  const state = { records: null, report: null, mapping: null, pack: "", fileBase: "erp", log: [], g: freshG(), guideOn: true, flash: null, packOk: true, prevDone: [] };

  // ---------- 小工具 ----------
  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    if (props) for (const [k, v] of Object.entries(props)) {
      if (k === "class") n.className = v;
      else if (v != null) n.setAttribute(k, v);
    }
    for (const k of kids.flat()) if (k != null) n.append(k instanceof Node ? k : document.createTextNode(String(k)));
    return n;
  }
  const money = (n) => Math.round(n).toLocaleString("zh-TW");
  const pct = (x) => (x == null ? "不適用" : (x * 100).toFixed(1) + "%");
  const pp = (x) => (x >= 0 ? "+" : "-") + Math.abs(x * 100).toFixed(1) + "pp";
  const blankText = (v) => (String(v).trim() === "" ? "（空白）" : String(v));

  function banner(msg, info) {
    const b = $("banner");
    if (!msg) { b.hidden = true; b.textContent = ""; return; }
    b.className = "banner" + (info ? " info" : "");
    b.textContent = msg;
    b.hidden = false;
    b.scrollIntoView({ block: "nearest" });
  }

  function table(headers, rows, emptyText) {
    if (!rows.length) return el("div", { class: "empty" }, emptyText || "沒有資料");
    // 表頭對齊方式跟著該欄第一列內容走（內容靠左的欄，表頭也靠左）
    const leftCol = headers.map((_, i) => {
      const c = rows[0][i];
      return i === 0 || (c instanceof Node && (c.classList.contains("l") || c.classList.contains("edit") || c.classList.contains("act")));
    });
    const thead = el("thead", null, el("tr", null, headers.map((h, i) => el("th", { class: leftCol[i] ? "l" : "" }, h))));
    const tbody = el("tbody", null, rows.map((r) => el("tr", null, r.map((c) => (c instanceof Node ? c : el("td", null, c))))));
    return el("table", null, thead, tbody);
  }
  function setContent(id, node) { $(id).replaceChildren(node); }

  function custCell(e) {
    const code = state.mapping.byTax.get(e.taxId);
    const small = e.codes.length > 1 ? `${code}　客戶代號 ${e.codes.join("、")}（已合併）` : `${code}　客戶代號 ${e.codes.join("、")}`;
    return el("td", { class: "l" }, e.name, el("small", null, small));
  }

  function fixMsg(text, kind) {
    const m = $("fixMsg");
    if (!text) { m.hidden = true; m.textContent = ""; return; }
    m.className = "fixmsg" + (kind ? " " + kind : "");
    m.textContent = text;
    m.hidden = false;
  }

  // ---------- 載入檔案 ----------
  async function handleFile(file) {
    banner("");
    if (!file) return;
    try {
      if (/\.(xlsx|xls)$/i.test(file.name)) {
        banner("這是 Excel 檔。目前請先在 Excel 另存新檔為「CSV UTF-8」再上傳。");
        return;
      }
      const buf = await file.arrayBuffer();
      const head = new Uint8Array(buf.slice(0, 4));
      if (head[0] === 0x50 && head[1] === 0x4b) { banner("這看起來是壓縮檔或 Excel 檔，不是 CSV。請另存為 CSV UTF-8 後再試。"); return; }
      const text = new TextDecoder("utf-8", { fatal: false }).decode(buf);
      const firstLine = text.split(/\r?\n/, 1)[0];
      if (firstLine.includes("�")) {
        banner("檔案不是 UTF-8 編碼（欄名出現亂碼）。請在 Excel 或記事本另存為「UTF-8」的 CSV 後再上傳。");
        return;
      }
      const res = cleanRows(parseCSV(text));
      if (res.error) { banner(res.error); return; }
      if (!res.records.length) { banner("檔案只有欄名，沒有任何資料列。"); return; }
      const base = defaultBaseDate(res.records.filter((r) => r.date));
      if (!base) { banner("所有資料列的單據日期都無法解析，請確認日期欄位格式。"); return; }
      state.records = res.records;
      state.fileBase = file.name.replace(/\.[^.]*$/, "") || "erp";
      state.mapping = null; // 新檔案 → 重新隨機編碼
      state.log = [];
      state.g = freshG(); state.packOk = true; state.prevDone = [];
      $("baseDate").value = base;
      $("app").hidden = false;
      $("reply").value = "";
      $("restored").replaceChildren();
      $("restoreSummary").textContent = "";
      fixMsg("");
      if (res.warning) banner(res.warning, true);
      recalc();
      $("sec-status").scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (err) {
      banner("讀取檔案時發生問題：" + (err && err.message ? err.message : "未知錯誤") + "。請確認是 ERP 匯出的 CSV。");
    }
  }

  // ---------- 計算與畫面 ----------
  function currentBase() {
    return $("baseDate").value || defaultBaseDate(state.records.filter((r) => r.date));
  }
  function runCompute() {
    const dropPts = Math.max(1, Number($("dropPts").value) || 5);
    return compute(state.records, currentBase(), { dropPts });
  }

  function recalc() {
    if (!state.records) return;
    const report = runCompute();
    state.report = report;

    if (!report.months.length) {
      banner("結帳基準日之前沒有任何可計算的資料，請把基準日調晚一點。", true);
      ["kpis", "t-alerts", "t-margin", "t-overdue", "t-below", "status", "issues", "fixlog"].forEach((id) => $(id).replaceChildren());
      state.pack = ""; $("pack").textContent = ""; $("selfcheck").textContent = "";
      updateGuide();
      return;
    }
    if ($("banner").classList.contains("info")) banner("");
    state.mapping = buildMapping(report, undefined, state.mapping);
    renderStatus(); renderIssues(); renderFixLog();
    renderKpis(); renderAlerts(); renderMargin(); renderOverdue(); renderBelow();
    renderPack();
    updateGuide();
  }

  // ---------- 資料檢查 ----------
  const GROUPS = {
    tax_blank: ["統一編號空白", "系統靠統一編號判斷是哪一家公司，沒有統編不敢合併，也不敢猜。請補上 8 碼統編，或確認這列先不納入。"],
    cost_bad: ["單位成本空白或無法解析", "沒有單位成本就算不出毛利，也不會用 0 代替。請補上單位成本，或確認這列先不納入。"],
    qty_bad: ["數量空白或無法解析", "數量是收入與成本的基礎。請補上數量，或確認這列先不納入。"],
    date_blank: ["單據日期空白", "日期不明就無法歸到哪個月。可輸入 2026/07/03 或民國 115/07/03。"],
    date_bad: ["單據日期無法判讀", "日期不明就無法歸到哪個月。可輸入 2026/07/03 或民國 115/07/03。"],
    zero_qty_no_price: ["數量為 0 且單價空白", "數量為 0 時，沒辦法用 金額÷數量 回推單價。請補上數量或單價，或確認這列先不納入。"],
    price_amount_missing: ["單價與未稅金額都空白", "兩者都沒有就不知道這筆賣多少錢。請補上其中之一，或確認這列先不納入。"],
    amount_unavailable: ["未稅金額無法取得", "請補上未稅金額，或確認這列先不納入。"],
    due_missing: ["帳款到期日空白", "不影響收入與成本，但這列無法判斷是否逾期。可補上到期日。"],
    due_bad: ["帳款到期日無法判讀", "不影響收入與成本，但這列無法判斷是否逾期。可輸入 2026/07/03 或 115/07/03。"],
    paid_bad: ["收款日期無法判讀", "目前視為「未收」。如果其實已收款，請補上正確日期。"],
    tax_format: ["統一編號不是 8 碼數字", "仍用這個號碼合併，沒有刪除。如果是打錯，可以修正。"],
    price_backfilled: ["單價空白，已用 未稅金額÷數量 回推", "這是系統依題目規則自動處理的，可以抽查。"],
    amount_backfilled: ["未稅金額空白，已用 數量×單價 回推", "這是系統依題目規則自動處理的，可以抽查。"],
  };
  const MAX_ROWS = 50;

  function summarizeStatus() {
    const recs = state.records;
    return {
      block: recs.filter((r) => r.status === "pending"),
      excluded: recs.filter((r) => r.status === "excluded"),
      edited: recs.filter((r) => r.edits.length),
    };
  }

  function renderStatus() {
    const r = state.report, n = r.notes;
    const s = summarizeStatus();
    const box = el("div", { class: "contents" });
    const card = (k, v, cls) => el("div", { class: cls || "" }, el("b", null, v), el("span", null, k));
    box.append(card("讀入資料列", state.records.length), card("納入計算", r.totals.rowsUsed));
    if (s.block.length) {
      const b = el("button", { class: "cardbtn", type: "button" }, el("b", null, s.block.length), el("span", null, "需要你處理（按一下前往）"));
      b.addEventListener("click", () => $("issues").scrollIntoView({ behavior: "smooth", block: "start" }));
      box.append(b);
    } else box.append(card("需要你處理", 0, "good"));
    box.append(card("確認不納入", s.excluded.length), card("人工修正", s.edited.length),
      card("基準日之後（略過）", r.totals.rowsLate), card("法人家數（依統編合併）", r.entities.length), card("重複建檔已合併", n.merged + " 家"));
    setContent("status", box);

    const badge = $("issueBadge");
    badge.className = "pill " + (s.block.length ? "bad" : "ok");
    badge.textContent = s.block.length ? `需要處理 ${s.block.length} 列` : "沒有需要處理的資料";

    const ed = $("editedPill");
    if (s.edited.length || s.excluded.length) {
      ed.hidden = false; ed.className = "pill";
      ed.textContent = `含 ${s.edited.length} 列人工修正、${s.excluded.length} 列確認不納入`;
    } else ed.hidden = true;
  }

  // 一列的「修正」欄：每個可修正欄位一個輸入框
  function fieldsOf(rec, level) {
    const set = new Set();
    for (const i of rec.issues) if (i.level === level) i.fields.forEach((f) => set.add(f));
    return KEYS.filter((k) => set.has(k));
  }

  function editCell(rec, fields) {
    const td = el("td", { class: "edit" });
    const inputs = {};
    for (const f of fields) {
      const inp = el("input", { type: "text", value: rec.raw[f], "aria-label": `${LABEL[f]}（第 ${rec.line} 行）`, autocomplete: "off", spellcheck: "false" });
      inputs[f] = inp;
      td.append(el("label", { class: "fieldedit" }, LABEL[f], inp));
    }
    const err = el("div", { class: "rowerr" });
    td.append(err);
    td._get = () => Object.fromEntries(Object.entries(inputs).map(([f, i]) => [f, i.value]));
    td._err = err;
    td._inputs = inputs;
    return td;
  }

  function issueRow(rec, level, opts) {
    const fields = fieldsOf(rec, level);
    const ed = editCell(rec, fields);
    const other = rec.issues.filter((i) => i.level === level).map((i) => i.msg);
    const apply = el("button", { class: "btn small primary", type: "button" }, "套用修正");
    const go = () => applyRowEdit(rec, ed);
    apply.addEventListener("click", go);
    Object.values(ed._inputs).forEach((i) => i.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); }));
    const act = el("td", { class: "act" }, apply);
    if (opts && opts.canExclude) {
      const ex = el("button", { class: "btn small", type: "button" }, "確認不納入");
      ex.addEventListener("click", () => excludeRow(rec));
      act.append(ex);
    }
    return [
      el("td", { class: "l" }, "第 " + rec.line + " 行"),
      el("td", { class: "l" }, rec.orderNo || "（空白）"),
      el("td", { class: "l" }, rec.custName || "（空白）", other.length > 1 ? el("small", null, other.join("；")) : null),
      rec.impact != null ? "NT$ " + money(rec.impact) : "—",
      ed, act,
    ];
  }

  function groupBlock(title, help, headers, rows, total, open) {
    const d = el("details", { class: "group" });
    if (open) d.setAttribute("open", "");
    d.append(el("summary", null, `${title}（${total} 列）`), el("p", { class: "help" }, help),
      el("div", { class: "tablewrap" }, table(headers, rows)));
    if (total > MAX_ROWS) d.append(el("p", { class: "help" }, `僅顯示前 ${MAX_ROWS} 列，其餘請先處理這些，畫面會自動補上。`));
    return d;
  }

  function renderIssues() {
    const root = el("div", { class: "contents" });
    const recs = state.records;

    // A. 需要你處理
    const blockRows = recs.filter((r) => r.status === "pending");
    const A = el("div", { class: "block" }, el("h3", null, `需要你處理（${blockRows.length} 列）：這些列目前沒有納入任何數字`));
    if (!blockRows.length) A.append(el("div", { class: "okline" }, "沒有需要處理的資料，所有資料列都已納入計算。"));
    else {
      const by = new Map();
      for (const r of blockRows) {
        const code = r.issues.find((i) => i.level === "block").code;
        if (!by.has(code)) by.set(code, []);
        by.get(code).push(r);
      }
      const H = ["位置", "訂單單號", "客戶名稱", "約影響收入", "修正", "操作"];
      for (const [code, list] of by) {
        list.sort((a, b) => (b.impact || 0) - (a.impact || 0));
        const [title, help] = GROUPS[code];
        A.append(groupBlock(title, help, H, list.slice(0, MAX_ROWS).map((r) => issueRow(r, "block", { canExclude: true })), list.length, true));
      }
    }
    root.append(A);

    // B. 提醒
    const infoRecs = recs.filter((r) => r.status !== "excluded" && r.issues.some((i) => i.level === "info"));
    if (infoRecs.length) {
      const B = el("div", { class: "block" }, el("h3", null, `提醒（${infoRecs.length} 列）：不影響收入與成本，但可能影響逾期判斷`));
      const by = new Map();
      for (const r of infoRecs) for (const i of r.issues.filter((x) => x.level === "info")) {
        if (!by.has(i.code)) by.set(i.code, new Set());
        by.get(i.code).add(r);
      }
      const H = ["位置", "訂單單號", "客戶名稱", "約影響收入", "修正", "操作"];
      for (const [code, set] of by) {
        const list = [...set];
        const [title, help] = GROUPS[code];
        const rows = list.slice(0, MAX_ROWS).map((r) => {
          const row = issueRow(r, "info");
          return row;
        });
        B.append(groupBlock(title, help, H, rows, list.length, false));
      }
      root.append(B);
    }

    // C. 系統已自動處理
    const autoRecs = recs.filter((r) => r.status === "ok" && r.issues.some((i) => i.level === "auto"));
    if (autoRecs.length) {
      const C = el("div", { class: "block" }, el("h3", null, `系統已自動處理（${autoRecs.length} 列）：可以抽查`));
      for (const code of ["price_backfilled", "amount_backfilled"]) {
        const list = autoRecs.filter((r) => r.issues.some((i) => i.code === code));
        if (!list.length) continue;
        const rows = list.slice(0, MAX_ROWS).map((r) => {
          const calc = code === "price_backfilled"
            ? `單價 = ${money(r.amount)} ÷ ${money(r.qty)} = ${r.price.toFixed(2)}`
            : `未稅金額 = ${money(r.qty)} × ${r.price.toFixed(2)} = ${r.amount.toFixed(2)}`;
          return [el("td", { class: "l" }, "第 " + r.line + " 行"), el("td", { class: "l" }, r.orderNo || "（空白）"),
            el("td", { class: "l" }, r.custName || "（空白）"), el("td", { class: "l" }, calc)];
        });
        const d = el("details", { class: "group" });
        d.append(el("summary", null, `${GROUPS[code][0]}（${list.length} 列）`), el("p", { class: "help" }, GROUPS[code][1]),
          el("div", { class: "tablewrap" }, table(["位置", "訂單單號", "客戶名稱", "系統回推"], rows)));
        if (list.length > MAX_ROWS) d.append(el("p", { class: "help" }, `僅顯示前 ${MAX_ROWS} 列。`));
        C.append(d);
      }
      root.append(C);
    }

    // D. 已確認不納入
    const ex = recs.filter((r) => r.status === "excluded");
    if (ex.length) {
      const D = el("div", { class: "block" }, el("h3", null, `已確認不納入（${ex.length} 列）`));
      const rows = ex.map((r) => {
        const b = el("button", { class: "btn small", type: "button" }, "還回待處理");
        b.addEventListener("click", () => unexcludeRow(r));
        return [el("td", { class: "l" }, "第 " + r.line + " 行"), el("td", { class: "l" }, r.orderNo || "（空白）"),
          el("td", { class: "l" }, r.custName || "（空白）"), el("td", { class: "l" }, r.problems.join("；")), el("td", { class: "act" }, b)];
      });
      D.append(el("div", { class: "tablewrap" }, table(["位置", "訂單單號", "客戶名稱", "原因", "操作"], rows)));
      root.append(D);
    }
    $("issues").replaceChildren(root);
  }

  // ---------- 修正動作 ----------
  function logEntry(rec, action, field, from, to) {
    state.log.push({ time: new Date().toLocaleString("zh-TW", { hour12: false }), line: rec ? rec.line : "", orderNo: rec ? rec.orderNo : "",
      action, field: field ? LABEL[field] : "", from: from == null ? "" : from, to: to == null ? "" : to });
  }

  function applyRowEdit(rec, td) {
    td._err.textContent = "";
    Object.values(td._inputs).forEach((i) => i.classList.remove("err"));
    const values = td._get();
    const changes = [];
    for (const [f, v] of Object.entries(values)) {
      if (v.trim() === String(rec.raw[f]).trim()) continue;
      const err = validateInput(f, v);
      if (err) {
        td._inputs[f].classList.add("err");
        td._err.textContent = `${LABEL[f]}：${err}`;
        td._inputs[f].focus();
        return;
      }
      changes.push([f, v.trim()]);
    }
    if (!changes.length) { td._err.textContent = "沒有任何變更。"; return; }
    const before = state.report.totals;
    const b = { revenue: before.revenue, margin: before.margin };
    for (const [f, v] of changes) {
      logEntry(rec, "修改", f, rec.raw[f], v);
      rec.edits.push({ field: f, from: rec.raw[f], to: v });
      rec.raw[f] = v;
    }
    const fresh = reclean(rec);
    state.records[rec.idx] = fresh;
    recalc();
    const a = state.report.totals;
    if (fresh.status === "ok") {
      const d = a.revenue - b.revenue;
      const dm = a.margin != null && b.margin != null ? `；整體毛利率 ${pct(b.margin)} → ${pct(a.margin)}` : "";
      fixMsg(`已修正第 ${fresh.line} 行。` + (d !== 0 ? `這列已納入計算，總收入 ${d > 0 ? "+" : "-"}NT$ ${money(Math.abs(d))}${dm}。` : "已更新。"), "");
    } else fixMsg(`已套用，但第 ${fresh.line} 行仍有問題：${fresh.problems.join("；")}`, "warn");
  }

  function excludeRow(rec) {
    rec.excluded = true;
    logEntry(rec, "確認不納入", "", "", "");
    state.records[rec.idx] = reclean(rec);
    recalc();
    fixMsg(`已確認第 ${rec.line} 行不納入計算。之後可以在「已確認不納入」把它還回待處理。`, "");
  }
  function unexcludeRow(rec) {
    rec.excluded = false;
    logEntry(rec, "還回待處理", "", "", "");
    state.records[rec.idx] = reclean(rec);
    recalc();
    fixMsg(`第 ${rec.line} 行已還回待處理。`, "");
  }
  function restoreRow(rec) {
    const fresh = reclean({ ...rec, raw: { ...rec.orig }, edits: [], excluded: false });
    logEntry(rec, "還原此列", "", "", "");
    state.records[rec.idx] = fresh;
    recalc();
    fixMsg(`第 ${rec.line} 行已還原成檔案中的原樣。`, "");
  }
  function restoreAll() {
    let n = 0;
    state.records = state.records.map((r) => {
      if (!r.edits.length && !r.excluded) return r;
      n++;
      return reclean({ ...r, raw: { ...r.orig }, edits: [], excluded: false });
    });
    logEntry(null, "全部還原", "", "", "");
    recalc();
    fixMsg(`已把 ${n} 列全部還原成檔案中的原樣。`, "");
  }

  // ---------- 修正紀錄與下載 ----------
  function renderFixLog() {
    const changed = state.records.filter((r) => r.edits.length || r.excluded);
    const root = el("div", { class: "block" }, el("h3", null, `修正紀錄與下載（${changed.length} 列有變動）`));
    root.append(el("p", { class: "small muted" },
      "所有修正只存在這個分頁的記憶體，關掉或重新整理就消失，所以請在離開前下載。真正的資料來源仍是 ERP，下載的修正後檔案可以拿去對照、回 ERP 補資料。"));
    if (changed.length) {
      const rows = changed.map((r) => {
        const b = el("button", { class: "btn small", type: "button" }, "還原此列");
        b.addEventListener("click", () => restoreRow(r));
        const diff = r.edits.map((e) => `${LABEL[e.field]}：${blankText(e.from)} → ${blankText(e.to)}`);
        const status = r.status === "ok" ? "已納入計算" : r.status === "excluded" ? "確認不納入" : "仍待處理";
        return [el("td", { class: "l" }, "第 " + r.line + " 行"), el("td", { class: "l" }, r.orderNo || "（空白）"),
          el("td", { class: "l" }, diff.length ? diff.join("；") : "（只標記不納入）"), el("td", { class: "l" }, status), el("td", { class: "act" }, b)];
      });
      root.append(el("div", { class: "tablewrap" }, table(["位置", "訂單單號", "變更內容（原值 → 新值）", "目前狀態", "操作"], rows)));
    }
    const dl1 = el("button", { class: "btn primary", type: "button" }, "下載修正後 CSV");
    const dl2 = el("button", { class: "btn", type: "button" }, "下載修正紀錄");
    const all = el("button", { class: "btn", type: "button" }, "全部還原");
    dl1.addEventListener("click", downloadCorrected);
    dl2.addEventListener("click", downloadLog);
    all.addEventListener("click", () => { if (changed.length) restoreAll(); });
    if (!changed.length) all.setAttribute("disabled", "");
    root.append(el("div", { class: "controls" }, dl1, dl2, all));
    root.append(el("p", { class: "small muted" },
      `檔名：${state.fileBase}_修正後.csv、${state.fileBase}_修正紀錄.csv。檔案含完整原始資料，只會存到你自己的電腦，請依公司規定保管。` +
      "修正後 CSV 保留所有資料列（包含標記不納入的），內容和原檔格式相同。用 Excel 直接開啟會讓統一編號、電話前面的 0 消失，建議用記事本檢視，或匯入時把這些欄位設成文字。"));
    $("fixlog").replaceChildren(root);
  }

  function saveFile(name, text) {
    const url = URL.createObjectURL(new Blob(["﻿" + text], { type: "text/csv;charset=utf-8" }));
    const a = el("a", { href: url, download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function downloadCorrected() {
    const rows = [HEADERS, ...state.records.map((r) => KEYS.map((k) => r.raw[k]))];
    saveFile(`${state.fileBase}_修正後.csv`, stringifyCSV(rows));
    fixMsg(`已下載 ${state.fileBase}_修正後.csv（${state.records.length} 列，含你修正過的值）。`, "");
  }
  function downloadLog() {
    const rows = [["時間", "資料行", "訂單單號", "動作", "欄位", "原值", "新值"],
      ...state.log.map((e) => [e.time, e.line, e.orderNo, e.action, e.field, e.from, e.to])];
    saveFile(`${state.fileBase}_修正紀錄.csv`, stringifyCSV(rows));
    fixMsg(`已下載 ${state.fileBase}_修正紀錄.csv（${state.log.length} 筆操作）。`, "");
  }

  // ---------- 報表 ----------
  function renderKpis() {
    const t = state.report.totals;
    const k = [
      ["總收入（未稅）", "NT$ " + money(t.revenue)], ["總成本", "NT$ " + money(t.cost)], ["整體毛利率", pct(t.margin)],
      ["逾期應收合計", "NT$ " + money(t.overdue)], ["低於成本的明細", state.report.belowCost.length + " 筆"],
    ];
    setContent("kpis", el("div", { class: "contents" }, k.map(([a, b]) => el("div", null, el("b", null, b), el("span", null, a)))));
  }

  function monthCells(e) {
    return state.report.months.map((m) => {
      const v = e.months[m];
      if (v.empty) return el("td", null, "無交易");
      const down = v.change != null && v.change * 100 <= -state.report.dropPts;
      return el("td", { class: down ? "bad" : "" }, pct(v.margin), v.change != null ? el("small", null, pp(v.change)) : null);
    });
  }

  function renderAlerts() {
    const r = state.report;
    const rows = r.entities.filter((e) => e.marginAlert.length).map((e) => [
      custCell(e), ...monthCells(e), el("td", { class: "l bad" }, e.marginAlert.join("；")), "NT$ " + money(e.revenue),
    ]);
    setContent("t-alerts", table(["客戶", ...r.months, "異常原因", "期間收入"], rows,
      `沒有客戶符合門檻（較前期下降 ${r.dropPts} 個百分點以上，或連續 3 期下滑）。`));
  }

  function renderMargin() {
    const r = state.report;
    const rows = r.entities.map((e) => [custCell(e), ...monthCells(e), pct(e.margin), "NT$ " + money(e.revenue)]);
    setContent("t-margin", table(["客戶", ...r.months, "期間毛利率", "期間收入"], rows));
  }

  function renderOverdue() {
    const r = state.report;
    const rows = r.overdueList.map((e) => {
      const a = e.overdue.aging;
      return [custCell(e), "NT$ " + money(e.overdue.amount), `${e.overdue.lines} / ${e.overdue.orders}`,
        e.overdue.maxDays + " 天", money(a.d1_30), money(a.d31_60), money(a.d61_90), money(a.d90p)];
    });
    setContent("t-overdue", table(["客戶", "逾期金額", "明細 / 訂單數", "最長逾期", "1-30 天", "31-60 天", "61-90 天", "90 天以上"], rows, "沒有逾期帳款。"));
  }

  function renderBelow() {
    const rows = state.report.belowCost.map((b) => [
      el("td", { class: "l" }, b.orderNo, el("small", null, "第 " + b.line + " 行")),
      el("td", { class: "l" }, b.custName), el("td", { class: "l" }, b.sku, el("small", null, b.skuName)),
      el("td", { class: "l" }, b.rep || "（未填）"), money(b.qty), b.price.toFixed(2), b.cost.toFixed(2),
      el("td", { class: "bad" }, (b.ratio * 100).toFixed(1) + "%"), "NT$ " + money(b.loss),
    ]);
    setContent("t-below", table(["訂單單號", "客戶", "品號 / 品名", "業務員", "數量", "單價", "單位成本", "售價 / 成本", "低於成本金額"], rows, "沒有低於成本的明細。"));
  }

  // ---------- AI 交接包 ----------
  function renderPack() {
    $("sizeMsg").textContent = ""; // 換檔案、改基準日等重新產生時，清掉上一次「已更新」的提示
    const pack = buildPack(state.report, state.mapping, { sizeMode: $("sizeMode").value });
    state.pack = pack;
    $("pack").textContent = pack; // 畫面顯示與複製 / 下載使用同一個字串
    const chk = selfCheck(pack, state.records);
    state.packOk = chk.ok;
    const box = $("selfcheck");
    box.className = "selfcheck " + (chk.ok ? "ok" : "bad");
    box.textContent = chk.ok
      ? `自動檢查通過：已比對 ${chk.tokenCount} 個來自這份檔案的原始值（名稱、統編、聯絡資料、訂單單號、品號、業務員、備註），交接包內一個都沒有；數字也只有百分比、天數、筆數等彙總形式，沒有金額、單價、成本、數量。`
      : `自動檢查未通過，請勿複製。發現 ${chk.hits.length} 個疑似原始值、${chk.badNumbers.length} 個非彙總數字。`;
    $("copyMsg").textContent = "";
  }

  function packIsConsistent() {
    return state.pack !== "" && $("pack").textContent === state.pack;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      const ta = el("textarea", { class: "offscreen", "aria-hidden": "true" });
      ta.value = text; document.body.append(ta); ta.select();
      let ok = false;
      try { ok = document.execCommand("copy"); } catch (_) { ok = false; }
      ta.remove();
      return ok;
    }
  }

  // ---------- 貼回還原 ----------
  function doRestore() {
    if (!state.mapping) return;
    const text = $("reply").value;
    if (!text.trim()) { $("restoreMsg").textContent = "請先貼上 AI 的回覆。"; return; }
    $("restoreMsg").textContent = "";
    const res = restore(text, state.mapping.table);
    const nodes = [];
    let nKnown = 0;
    for (const s of res.segments) {
      if (s.type === "text") nodes.push(document.createTextNode(s.value));
      else if (s.type === "known") {
        nKnown++;
        nodes.push(el("mark", { class: "known", title: `${s.code}（${s.kind}）` }, s.value));
      } else {
        nodes.push(el("mark", { class: "unknown", title: "對照表沒有這個代號，可能是 AI 編造的" }, `${s.code}（查無此代號，未還原）`));
      }
    }
    $("restored").replaceChildren(...nodes);
    const parts = [`已還原 ${nKnown} 處（${res.known.size} 個不同代號）`];
    if (res.unknown.length) parts.push(`查無此代號 ${res.unknown.length} 個：${res.unknown.join("、")}，已標紅，請向 AI 或業務確認`);
    $("restoreSummary").textContent = parts.join("；") + "。";
    state.g.restored = true; updateGuide();
  }

  // ---------- 清除 ----------
  function resetAll() {
    state.records = null; state.report = null; state.mapping = null; state.pack = ""; state.log = [];
    state.g = freshG(); state.packOk = true; state.prevDone = [];
    ["status", "kpis", "t-alerts", "t-margin", "t-overdue", "t-below", "issues", "fixlog", "pack", "selfcheck", "restored", "restoreSummary", "copyMsg", "restoreMsg", "sizeMsg"]
      .forEach((id) => $(id).replaceChildren());
    $("reply").value = ""; $("file").value = "";
    fixMsg(""); $("editedPill").hidden = true; $("issueBadge").textContent = "";
    $("app").hidden = true; banner("");
    updateGuide();
  }

  // ---------- 操作引導（步驟列、下一步提示、光圈動畫） ----------
  function freshG() { return { skipped: false, reportSeen: false, copied: false, restored: false }; }
  const reduceMotion = () => window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let flashTimer = null;

  function guideInput() {
    const has = !!state.records;
    return {
      hasFile: has, blockCount: has ? state.records.filter((r) => r.status === "pending").length : 0,
      skipped: state.g.skipped, reportSeen: state.g.reportSeen, copied: state.g.copied,
      replyFilled: $("reply").value.trim() !== "", restored: state.g.restored, packOk: state.packOk,
    };
  }

  function scrollTo(id, block) {
    const t = $(id);
    if (!t) return;
    t.scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth", block: block || "center" });
    const f = t.matches("button, textarea, input") ? t : t.querySelector(":scope > textarea");
    if (f) f.focus({ preventScroll: true });
  }

  function clearHints() {
    document.querySelectorAll(".hint-target, .hint-section").forEach((n) => {
      n.classList.remove("hint-target", "hint-section");
      n.removeAttribute("data-hint");
    });
    document.querySelectorAll(".hint-room").forEach((n) => n.classList.remove("hint-room"));
  }

  function stepClick(st) {
    if (!state.records && st.id > 1) {
      state.flash = "請先上傳 ERP 匯出的 CSV，才能進行這一步。";
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => { state.flash = null; updateGuide(); }, 3500);
      updateGuide();
      return;
    }
    scrollTo(st.anchor, "start");
  }

  function updateGuide() {
    const r = nextStep(guideInput());

    // 步驟列：剛完成的步驟才播放打勾動畫
    const ol = $("stepper");
    ol.replaceChildren(...STEPS.map((st, i) => {
      const done = r.done[i], cur = r.current === st.id;
      const fresh = done && !state.prevDone[i];
      const b = el("button", {
        type: "button", class: "step" + (done ? " done" : "") + (cur ? " current" : "") + (fresh ? " fresh" : "") + (!state.records && st.id > 1 ? " locked" : ""),
        "aria-current": cur ? "step" : null, "aria-label": `第 ${st.id} 步 ${st.name}${done ? "（已完成）" : ""}`,
      }, el("span", { class: "dot" }, done ? "✓" : String(st.id)), el("span", { class: "name" }, st.name));
      b.addEventListener("click", () => stepClick(st));
      return el("li", null, b);
    }));
    state.prevDone = r.done.slice();

    // 提示條
    const coach = $("coach");
    clearHints();
    const toggle = el("button", { class: "linkbtn", type: "button" }, state.guideOn ? "關閉提示" : "開啟提示");
    toggle.addEventListener("click", () => { state.guideOn = !state.guideOn; updateGuide(); });
    if (!state.guideOn) {
      coach.className = "coach off";
      coach.replaceChildren(el("span", { class: "small muted" }, "操作提示已關閉。"), toggle);
      return;
    }
    coach.className = "coach" + (r.tone === "warn" ? " warn" : "");
    const kids = [el("span", { class: "tagnext" }, r.current === 6 ? "完成" : "下一步"), el("span", { class: "msg" }, state.flash || r.msg)];
    for (const a of r.actions) {
      const b = el("button", { class: "btn small" + (a.id === "go" ? " primary" : ""), type: "button" }, a.label);
      b.addEventListener("click", () => {
        if (a.id === "go") scrollTo(r.target.id);
        else if (a.id === "skip") { state.g.skipped = true; updateGuide(); scrollTo("sec-report", "start"); }
        else if (a.id === "seen") {
          state.g.reportSeen = true; updateGuide();
          const n = nextStep(guideInput());
          if (n.target) scrollTo(n.target.id);
        }
      });
      kids.push(b);
    }
    kids.push(toggle);
    coach.replaceChildren(...kids);
    if (r.target) {
      const t = $(r.target.id);
      if (t) {
        if (r.target.kind === "section") t.classList.add("hint-section");
        else {
          t.classList.add("hint-target"); t.setAttribute("data-hint", r.target.hint);
          // 標籤顯示在按鈕上方，替它預留一點空間，才不會蓋住旁邊的文字（選檔按鈕與貼回框的標籤位置另有處理）
          if (t.parentElement && !["pickBtn", "replyWrap"].includes(t.id)) t.parentElement.classList.add("hint-room");
        }
      }
    }
  }

  // ---------- 事件 ----------
  $("file").addEventListener("change", (e) => handleFile(e.target.files[0]));
  const drop = $("drop");
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => handleFile(e.dataTransfer.files[0]));
  drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("file").click(); } });
  // 避免把檔案拖到頁面其他地方時，瀏覽器直接開啟檔案
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => e.preventDefault());

  $("baseDate").addEventListener("change", () => { fixMsg(""); recalc(); });
  $("dropPts").addEventListener("change", recalc);
  $("sizeMode").addEventListener("change", () => {
    if (!(state.report && state.report.months.length)) return;
    renderPack();
    // 規模資訊只出現在交接包比較下面的段落，改選項後要明確告訴使用者有沒有變、變在哪裡
    const n = (state.pack.match(/大客戶|中客戶|小客戶/g) || []).length;
    $("sizeMsg").textContent = $("sizeMode").value === "band"
      ? `已更新為「只給大 / 中 / 小級距」：交接包 ${state.pack.length} 字，共 ${n} 處標示客戶規模（從「毛利異常客戶」那一段開始，每行結尾）。`
      : `已更新為「完全不給」：交接包 ${state.pack.length} 字，不含任何客戶規模資訊。`;
  });
  $("reset").addEventListener("click", resetAll);

  $("copy").addEventListener("click", async () => {
    if (!packIsConsistent()) { $("copyMsg").textContent = "畫面內容與待複製內容不一致，已拒絕複製，請重新整理。"; return; }
    const ok = await copyText(state.pack);
    state.g.copied = true; updateGuide();
    $("copyMsg").textContent = ok ? `已複製（${state.pack.length} 字），內容與畫面上完全相同。` : "瀏覽器不允許自動複製，請在上方框內全選後手動複製。";
  });
  $("download").addEventListener("click", () => {
    if (!packIsConsistent()) { $("copyMsg").textContent = "畫面內容與待下載內容不一致，已拒絕下載。"; return; }
    const url = URL.createObjectURL(new Blob([state.pack], { type: "text/plain;charset=utf-8" }));
    const a = el("a", { href: url, download: "ai-handoff-pack.txt" });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    $("copyMsg").textContent = "已下載 ai-handoff-pack.txt，內容與畫面上完全相同。";
  });
  $("doRestore").addEventListener("click", doRestore);
  $("reply").addEventListener("input", updateGuide);

  // 捲到交接包區塊，代表報表已經看過
  if ("IntersectionObserver" in window) {
    new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && state.records && !state.g.reportSeen) { state.g.reportSeen = true; updateGuide(); }
    }, { rootMargin: "0px 0px -25% 0px" }).observe($("sec-pack"));
  }
  updateGuide();
})();
