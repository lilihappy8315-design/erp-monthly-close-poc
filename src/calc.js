/* 月結計算：所有數字都由這裡的程式算出，AI 不參與計算。
 * 口徑（與題目一致）：
 *   收入 = Σ 未稅金額；成本 = Σ 數量×單位成本；毛利率 = (收入 - 成本) ÷ 收入（收入為 0 → 不適用）
 *   逾期 = 到基準日仍無收款日期（或收款日晚於基準日），且到期日早於基準日；只計正數應收
 *   只納入單據日期 ≤ 基準日、且未被列為待處理的資料
 */
(function (g) {
  const ERP = (g.ERP = g.ERP || {});

  const DAY = 86400000;
  const toTime = (iso) => Date.parse(iso + "T00:00:00Z");
  const daysBetween = (fromIso, toIso) => Math.round((toTime(toIso) - toTime(fromIso)) / DAY);

  function monthEnd(iso) {
    const [y, m] = iso.split("-").map(Number);
    const d = new Date(Date.UTC(y, m, 0));
    return d.toISOString().slice(0, 10);
  }

  function nextMonth(ym) {
    let [y, m] = ym.split("-").map(Number);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
    return `${y}-${String(m).padStart(2, "0")}`;
  }

  // 預設基準日：檔案中「最晚單據日期」所在月份的最後一天
  function defaultBaseDate(records) {
    let max = null;
    for (const r of records) if (r.date && (!max || r.date > max)) max = r.date;
    return max ? monthEnd(max) : null;
  }

  const margin = (rev, cost) => (rev === 0 ? null : (rev - cost) / rev);

  function mostCommon(arr) {
    const c = new Map();
    for (const a of arr) if (a) c.set(a, (c.get(a) || 0) + 1);
    let best = "", n = 0;
    for (const [k, v] of c) if (v > n) { best = k; n = v; }
    return best;
  }

  function compute(records, baseDate, opts) {
    const dropPts = (opts && opts.dropPts != null ? opts.dropPts : 5) / 100;
    const pending = records.filter((r) => r.status === "pending");
    const excluded = records.filter((r) => r.status === "excluded");
    const valid = records.filter((r) => r.status === "ok");
    const lateRows = valid.filter((r) => r.date > baseDate);
    const used = valid.filter((r) => r.date <= baseDate);

    // 月份清單（連續）
    let months = [];
    if (used.length) {
      const ms = used.map((r) => r.date.slice(0, 7)).sort();
      for (let m = ms[0]; m <= ms[ms.length - 1]; m = nextMonth(m)) months.push(m);
    }

    const ents = new Map();
    const monthly = Object.fromEntries(months.map((m) => [m, { revenue: 0, cost: 0 }]));
    const belowCost = [];
    let totalRev = 0, totalCost = 0;

    for (const r of used) {
      let e = ents.get(r.taxId);
      if (!e) {
        e = { taxId: r.taxId, nameList: [], codes: new Set(), months: {}, revenue: 0, cost: 0,
              overdue: { amount: 0, lines: 0, orders: new Set(), maxDays: 0, aging: { d1_30: 0, d31_60: 0, d61_90: 0, d90p: 0 } } };
        ents.set(r.taxId, e);
      }
      if (r.custName) e.nameList.push(r.custName); // 名稱空白的列不算一種「名稱寫法」
      if (r.custCode) e.codes.add(r.custCode);
      const mk = r.date.slice(0, 7);
      const mo = (e.months[mk] = e.months[mk] || { revenue: 0, cost: 0 });
      const lineCost = r.qty * r.cost;
      mo.revenue += r.amount; mo.cost += lineCost;
      e.revenue += r.amount; e.cost += lineCost;
      monthly[mk].revenue += r.amount; monthly[mk].cost += lineCost;
      totalRev += r.amount; totalCost += lineCost;

      // 逾期（只計正數應收）
      const unpaid = !r.paid || r.paid > baseDate;
      if (r.qty > 0 && r.amount > 0 && unpaid && r.due && r.due < baseDate) {
        const days = daysBetween(r.due, baseDate);
        const o = e.overdue;
        o.amount += r.amount; o.lines += 1; o.orders.add(r.orderNo);
        o.maxDays = Math.max(o.maxDays, days);
        if (days <= 30) o.aging.d1_30 += r.amount;
        else if (days <= 60) o.aging.d31_60 += r.amount;
        else if (days <= 90) o.aging.d61_90 += r.amount;
        else o.aging.d90p += r.amount;
      }

      // 低於成本（退貨列不算）
      if (r.qty > 0 && r.price != null && r.price < r.cost) {
        belowCost.push({ line: r.line, orderNo: r.orderNo, taxId: r.taxId, custName: r.custName, sku: r.sku,
          skuName: r.skuName, rep: r.rep, qty: r.qty, price: r.price, cost: r.cost,
          loss: r.qty * r.cost - r.amount, ratio: r.price / r.cost });
      }
    }

    const entities = [];
    for (const e of ents.values()) {
      // 逐月毛利率與變化（百分點）
      let prev = null;
      const mm = {};
      for (const m of months) {
        const v = e.months[m];
        if (!v) { mm[m] = { revenue: 0, cost: 0, margin: null, change: null, empty: true }; continue; }
        const mg = margin(v.revenue, v.cost);
        mm[m] = { revenue: v.revenue, cost: v.cost, margin: mg, change: mg != null && prev != null ? mg - prev : null };
        if (mg != null) prev = mg;
      }
      // 毛利異常判斷
      const seq = months.map((m) => mm[m].margin).filter((x) => x != null);
      const reasons = [];
      if (seq.length >= 2 && seq[seq.length - 1] - seq[seq.length - 2] <= -dropPts)
        reasons.push(`最近一期較前期下降 ${(((seq[seq.length - 2] - seq[seq.length - 1]) * 100)).toFixed(1)} 個百分點`);
      if (seq.length >= 3) {
        const t = seq.slice(-3);
        if (t[0] > t[1] && t[1] > t[2] && t[0] - t[2] >= dropPts)
          reasons.push(`連續 3 期下滑，共降 ${((t[0] - t[2]) * 100).toFixed(1)} 個百分點`);
      }
      if (seq.length && seq[seq.length - 1] < 0) reasons.push("最近一期毛利為負");

      const o = e.overdue;
      entities.push({
        taxId: e.taxId,
        name: mostCommon(e.nameList) || "（客戶名稱空白）",
        names: [...new Set(e.nameList)],
        codes: [...e.codes].sort(),
        months: mm,
        revenue: e.revenue, cost: e.cost, margin: margin(e.revenue, e.cost),
        share: totalRev === 0 ? null : e.revenue / totalRev,
        marginAlert: reasons,
        overdue: { amount: o.amount, lines: o.lines, orders: o.orders.size, maxDays: o.maxDays, aging: o.aging },
      });
    }
    entities.sort((a, b) => b.revenue - a.revenue);

    const overdueTotal = entities.reduce((s, e) => s + e.overdue.amount, 0);
    const has = (r, ...codes) => r.issues.some((i) => codes.includes(i.code));
    const notes = {
      priceBackfilled: used.filter((r) => has(r, "price_backfilled")).length,
      amountBackfilled: used.filter((r) => has(r, "amount_backfilled")).length,
      dueMissing: used.filter((r) => has(r, "due_missing", "due_bad")).length,
      taxFormat: used.filter((r) => has(r, "tax_format")).length,
      merged: entities.filter((e) => e.codes.length > 1 || e.names.length > 1).length,
    };

    return {
      baseDate, months, dropPts: dropPts * 100,
      totals: { revenue: totalRev, cost: totalCost, margin: margin(totalRev, totalCost), rowsUsed: used.length,
                rowsLate: lateRows.length, rowsPending: pending.length, rowsExcluded: excluded.length,
                rowsEdited: records.filter((r) => r.edits && r.edits.length).length, overdue: overdueTotal },
      monthly: Object.fromEntries(months.map((m) => [m, { ...monthly[m], margin: margin(monthly[m].revenue, monthly[m].cost) }])),
      entities,
      overdueList: entities.filter((e) => e.overdue.amount > 0).sort((a, b) => b.overdue.amount - a.overdue.amount),
      belowCost: belowCost.sort((a, b) => b.loss - a.loss),
      pending, excluded, notes,
    };
  }

  ERP.calc = { daysBetween, monthEnd, defaultBaseDate, compute };
  if (typeof module === "object" && module.exports) module.exports = ERP.calc;
})(typeof globalThis !== "undefined" ? globalThis : this);
