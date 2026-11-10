/* 假名化與 AI 交接包
 * - 同一統編 → 同一假名代號（C-xxx）；代號每次上傳重新隨機編排，對照表只存在記憶體。
 * - 交接包只含：假名代號、百分比 / 百分點、天數、筆數、占比、提示文字。
 *   不含：任何名稱、統編、聯絡資料、備註、品名、金額、單價、成本、數量、日期明細。
 * - 還原：把 AI 回覆中的代號換回真實名稱；對照表沒有的代號標示為「不存在」。
 */
(function (g) {
  const ERP = (g.ERP = g.ERP || {});

  function secureRandomInt(max) {
    const c = g.crypto;
    if (c && c.getRandomValues) {
      const buf = new Uint32Array(1);
      const lim = Math.floor(0x100000000 / max) * max;
      let x;
      do { c.getRandomValues(buf); x = buf[0]; } while (x >= lim);
      return x % max;
    }
    return Math.floor(Math.random() * max);
  }

  function shuffle(arr, randInt) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = randInt(i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  const pad = (n, w) => String(n).padStart(w, "0");

  // 建立 / 延伸對照表：code → { kind, label }
  // prev 為同一次工作階段先前建立的對照表；已編過的項目沿用原代號（改基準日後代號不變），新項目才配新代號。
  function buildMapping(report, randInt, prev) {
    randInt = randInt || secureRandomInt;
    const m = prev || { table: new Map(), byTax: new Map(), byOrder: new Map(), bySku: new Map(), byRep: new Map() };

    function assign(keys, byMap, prefix, width, kind, labelOf) {
      const fresh = shuffle(keys.filter((k) => !byMap.has(k)), randInt);
      let n = byMap.size;
      for (const k of fresh) {
        n += 1;
        const code = `${prefix}-${pad(n, width)}`;
        byMap.set(k, code);
        m.table.set(code, { kind, label: labelOf(k) });
      }
    }
    const entName = new Map(report.entities.map((e) => [e.taxId, e.name || "(未命名)"]));
    assign(report.entities.map((e) => e.taxId), m.byTax, "C", Math.max(3, String(report.entities.length).length), "客戶", (k) => entName.get(k));
    assign([...new Set(report.belowCost.map((b) => b.orderNo))], m.byOrder, "O", 3, "訂單", (k) => k);
    const skuLabel = new Map(report.belowCost.map((b) => [b.sku, b.skuName ? `${b.sku} ${b.skuName}` : b.sku]));
    assign([...skuLabel.keys()], m.bySku, "P", 3, "品項", (k) => skuLabel.get(k));
    assign([...new Set(report.belowCost.map((b) => b.rep).filter(Boolean))], m.byRep, "R", 2, "業務員", (k) => k);
    return m;
  }

  const pct = (x, d = 1) => (x == null ? "不適用" : `${(x * 100).toFixed(d)}%`);
  const pp = (x) => `${x >= 0 ? "+" : "-"}${Math.abs(x * 100).toFixed(1)}pp`;
  const share = (x) => `${Math.round(x * 100)}%`;

  const DATA_START = "【整體概況】";
  const DATA_END = "【請你輸出】";

  // 客戶規模級距：依營收排名，前 20% 為大、接著 30% 為中、其餘為小（營收 <= 0 一律為小）
  function sizeTiers(report) {
    const ranked = report.entities.filter((e) => e.revenue > 0).sort((a, b) => b.revenue - a.revenue);
    const nBig = Math.max(1, Math.ceil(ranked.length * 0.2));
    const nMid = Math.ceil(ranked.length * 0.3);
    const t = new Map();
    report.entities.forEach((e) => t.set(e.taxId, "小客戶"));
    ranked.forEach((e, i) => t.set(e.taxId, i < nBig ? "大客戶" : i < nBig + nMid ? "中客戶" : "小客戶"));
    return t;
  }

  // opts.sizeMode：'band'（預設，只給大/中/小級距）或 'none'（完全不給規模資訊）
  function buildPack(report, map, opts) {
    const sizeMode = (opts && opts.sizeMode) || "band";
    const tiers = sizeTiers(report);
    const sizeText = (e) => (sizeMode === "band" ? `；規模：${tiers.get(e.taxId)}` : "");
    const L = [];
    const mons = report.months;
    L.push("【任務】");
    L.push("你是一位謹慎的財務分析顧問。以下是某製造業公司的月結彙總指標，請替管理部經理撰寫「給老闆看的月結摘要與下一步建議」。");
    L.push("");
    L.push("【使用規則】");
    L.push("1. 資料中的客戶、訂單、品項、業務員都已改成代號（C- 開頭是客戶、O- 開頭是訂單、P- 開頭是品項、R- 開頭是業務員）。請只用這些代號稱呼，不要猜測或編造真實名稱。");
    L.push("2. 所有數字都已由程式算好。請直接引用，不要重新計算，也不要推測沒有提供的金額、單價或成本。");
    L.push("3. 「pp」代表百分點。毛利率變化是前一期與本期毛利率的差。");
    L.push("4. 措辭保持中性，描述現象與可能原因即可，不要指責個人（包含業務員）；原因不確定時請寫成「需要向業務確認」。");
    L.push("5. 如果資料不足以下結論，請直接說明，不要硬寫。");
    L.push("");
    L.push(DATA_START);
    L.push(`資料期間：${mons[0]} 至 ${mons[mons.length - 1]}；結帳基準日：${report.baseDate}`);
    L.push("各月整體毛利率：" + mons.map((m) => `${m} ${pct(report.monthly[m].margin)}`).join("｜"));
    L.push(`期間整體毛利率：${pct(report.totals.margin)}`);
    L.push(`客戶（以統一編號合併後）共 ${report.entities.length} 家；其中 ${report.notes.merged} 家有重複建檔，已合併為同一代號。`);
    L.push(`資料品質：待處理 ${report.totals.rowsPending} 列（缺少必要欄位，未納入上述指標）；經人工修正 ${report.totals.rowsEdited} 列；確認不納入 ${report.totals.rowsExcluded} 列。`);
    L.push("");

    // 毛利異常
    const alerts = report.entities.filter((e) => e.marginAlert.length);
    L.push(`【毛利異常客戶】（判定門檻：較前期下降 ${report.dropPts} 個百分點以上，或連續 3 期下滑）`);
    if (!alerts.length) L.push("（沒有客戶符合門檻）");
    for (const e of alerts) {
      const seq = mons.map((m) => pct(e.months[m].margin)).join(" → ");
      L.push(`${map.byTax.get(e.taxId)}：逐月毛利率 ${seq}；${e.marginAlert.join("；")}${sizeText(e)}`);
    }
    L.push("");

    // 各客戶逐月毛利率
    L.push("【各客戶逐月毛利率】（欄位順序：" + mons.join("、") + "；括號內為較前期變化" +
      (sizeMode === "band" ? "；最後是客戶規模級距，依營收排名，前 20% 為大、其後 30% 為中、其餘為小" : "") + "）");
    const rows = report.entities.map((e) => ({ code: map.byTax.get(e.taxId), e }))
      .sort((a, b) => a.code.localeCompare(b.code));
    for (const { code, e } of rows) {
      const cells = mons.map((m) => {
        const v = e.months[m];
        if (v.empty) return "無交易";
        return v.change == null ? pct(v.margin) : `${pct(v.margin)}(${pp(v.change)})`;
      });
      L.push(`${code}：${cells.join("｜")}${sizeMode === "band" ? "｜" + tiers.get(e.taxId) : ""}`);
    }
    L.push("");

    // 逾期
    const od = report.overdueList;
    const odTotal = report.totals.overdue;
    L.push("【逾期帳款】（到基準日仍未收款且已過到期日；帳齡占比為占該客戶逾期帳款的比例）");
    if (!od.length) L.push("（沒有逾期帳款）");
    else L.push(`逾期客戶共 ${od.length} 家。`);
    for (const e of od) {
      const a = e.overdue.aging;
      const t = e.overdue.amount;
      L.push(`${map.byTax.get(e.taxId)}：逾期 ${e.overdue.lines} 筆明細、涉及 ${e.overdue.orders} 張訂單，最長逾期 ${e.overdue.maxDays} 天；` +
        `占全體逾期帳款 ${share(t / odTotal)}；帳齡 1-30 天 ${share(a.d1_30 / t)}｜31-60 天 ${share(a.d31_60 / t)}｜61-90 天 ${share(a.d61_90 / t)}｜90 天以上 ${share(a.d90p / t)}`);
    }
    L.push("");

    // 低於成本
    L.push("【低於成本的訂單明細】（售價為成本的百分比；低於 100% 即賣得比成本低）");
    const bc = report.belowCost;
    if (!bc.length) L.push("（沒有低於成本的明細）");
    else {
      L.push(`共 ${bc.length} 筆明細、涉及 ${new Set(bc.map((b) => b.orderNo)).size} 張訂單、${new Set(bc.map((b) => b.taxId)).size} 家客戶。`);
      // 同一訂單、同一品項的多筆明細合併成一行，避免重複
      const groups = new Map();
      for (const b of bc) {
        const key = `${b.orderNo}|${b.sku}`;
        const gp = groups.get(key) || { b, n: 0, lo: Infinity, hi: -Infinity };
        gp.n += 1; gp.lo = Math.min(gp.lo, b.ratio); gp.hi = Math.max(gp.hi, b.ratio);
        groups.set(key, gp);
      }
      const lines = [...groups.values()].map(({ b, n, lo, hi }) => {
        const rep = b.rep ? map.byRep.get(b.rep) : "未填業務員";
        const r = Math.abs(hi - lo) < 0.0005 ? `${(lo * 100).toFixed(1)}%` : `${(lo * 100).toFixed(1)}% 到 ${(hi * 100).toFixed(1)}%`;
        return `${map.byOrder.get(b.orderNo)}：客戶 ${map.byTax.get(b.taxId)}、品項 ${map.bySku.get(b.sku)}、業務員 ${rep}，共 ${n} 筆明細，售價為成本的 ${r}`;
      }).sort();
      L.push(...lines);
    }
    L.push("");
    L.push(DATA_END);
    L.push("請用繁體中文，依序輸出：");
    L.push("A. 給老闆的月結摘要（5 句以內）");
    L.push("B. 最需要優先關注的 3 到 5 個項目（每項寫出代號、依據的數字、為什麼重要）");
    L.push("C. 下一步建議（具體、可執行、有先後順序）");
    L.push("D. 需要經理再向業務或客戶確認的問題");
    return L.join("\n");
  }

  // 自我檢查：交接包中不得出現任何原始值；數字只允許百分比、百分點、天數、筆數等彙總形式
  function selfCheck(pack, records) {
    const tokens = new Set();
    const add = (v, min) => { if (v && v.length >= min) tokens.add(v); };
    for (const r of records) {
      add(r.custCode, 3); add(r.custName, 2); add(r.taxId, 6); add(r.contact, 2); add(r.phone, 5);
      add(r.email, 5); add(r.addr, 4); add(r.rep, 2); add(r.orderNo, 4); add(r.sku, 3); add(r.skuName, 3);
      add(r.remark, 4);
    }
    const hits = [];
    for (const t of tokens) if (pack.includes(t)) hits.push(t);

    // 只檢查「資料區」的數字；說明文字另行審閱
    const a = pack.indexOf(DATA_START), b = pack.indexOf(DATA_END);
    let data = a >= 0 && b > a ? pack.slice(a, b) : pack;
    data = data
      .replace(/\b[CORP]-\d{2,}\b/g, "")
      .replace(/\d{4}-\d{2}(-\d{2})?/g, "")
      .replace(/\d+-\d+\s*天/g, "")
      .replace(/\d+(\.\d+)?(pp|%)/g, "")
      .replace(/\d+(\.\d+)?\s*(天|筆|張|家|列|期|個百分點)/g, "");
    const badNumbers = data.match(/\d+(\.\d+)?/g) || [];
    return { ok: hits.length === 0 && badNumbers.length === 0, tokenCount: tokens.size, hits, badNumbers };
  }

  // 還原：回傳片段陣列，由畫面用純文字（textContent）渲染，絕不當 HTML
  function restore(text, table) {
    const re = /(?<![A-Za-z0-9-])([CORP])-(\d{2,})(?![A-Za-z0-9])/g;
    const segs = [];
    const known = new Map();
    const unknown = new Set();
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) segs.push({ type: "text", value: text.slice(last, m.index) });
      const code = m[0];
      const hit = table.get(code);
      if (hit) {
        segs.push({ type: "known", code, kind: hit.kind, value: hit.label });
        known.set(code, hit);
      } else {
        segs.push({ type: "unknown", code, value: code });
        unknown.add(code);
      }
      last = m.index + code.length;
    }
    if (last < text.length) segs.push({ type: "text", value: text.slice(last) });
    return { segments: segs, known, unknown: [...unknown] };
  }

  ERP.pseudo = { buildMapping, buildPack, selfCheck, restore, DATA_START, DATA_END };
  if (typeof module === "object" && module.exports) module.exports = ERP.pseudo;
})(typeof globalThis !== "undefined" ? globalThis : this);
