// 以產生器「乾淨值」獨立算出的標準答案 (*.truth.json)，核對網站計算核心的結果。
// 執行：node --test tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
require("../src/csv.js");
const clean = require("../src/clean.js");
const calc = require("../src/calc.js");
const { parseCSV } = require("../src/csv.js");

const root = path.join(__dirname, "..");
const files = ["data/synthetic_erp", "data/blind_test_a", "data/blind_test_b"].filter((f) => fs.existsSync(path.join(root, f + ".csv")));

function load(base) {
  const text = fs.readFileSync(path.join(root, base + ".csv"), "utf8");
  const truth = JSON.parse(fs.readFileSync(path.join(root, base + ".truth.json"), "utf8"));
  const { records } = clean.cleanRows(parseCSV(text));
  const rep = calc.compute(records, truth.base_date);
  return { records, truth, rep, text };
}

for (const base of files) {
  test(`${base}: 預設基準日 = 最晚單據日期所在月底`, () => {
    const { records, truth } = load(base);
    assert.equal(calc.defaultBaseDate(records), truth.base_date);
  });

  test(`${base}: 總收入、總成本、逾期合計、待處理筆數`, () => {
    const { truth, rep } = load(base);
    assert.ok(Math.abs(rep.totals.revenue - truth.total_revenue) < 0.05, `rev ${rep.totals.revenue} vs ${truth.total_revenue}`);
    assert.ok(Math.abs(rep.totals.cost - truth.total_cost) < 0.5, `cost ${rep.totals.cost} vs ${truth.total_cost}`);
    assert.ok(Math.abs(rep.totals.overdue - truth.overdue_total) < 0.05);
    assert.equal(rep.totals.rowsPending, truth.pending_count);
  });

  test(`${base}: 法人依統編合併，數量一致`, () => {
    const { truth, rep } = load(base);
    assert.equal(rep.entities.length, truth.entity_count);
  });

  test(`${base}: 每家法人逐月收入 / 毛利率 / 逾期金額 / 最長逾期天數`, () => {
    const { truth, rep } = load(base);
    for (const e of rep.entities) {
      const t = truth.entities[e.taxId];
      assert.ok(t, `truth 缺 ${e.taxId}`);
      for (const [m, tv] of Object.entries(t.months)) {
        assert.ok(Math.abs(e.months[m].revenue - tv.revenue) < 0.05, `${e.taxId} ${m} 收入`);
        assert.ok(Math.abs(e.months[m].margin - tv.margin) < 1e-5, `${e.taxId} ${m} 毛利率`);
      }
      assert.ok(Math.abs(e.overdue.amount - t.overdue_amount) < 0.05, `${e.taxId} 逾期金額`);
      assert.equal(e.overdue.maxDays, t.max_overdue_days, `${e.taxId} 最長逾期`);
    }
  });

  test(`${base}: 低於成本的明細與標準答案一致`, () => {
    const { truth, rep } = load(base);
    const got = rep.belowCost.map((b) => `${b.orderNo}|${b.sku}`).sort();
    const want = truth.below_cost_lines.map((x) => x.join("|")).sort();
    assert.deepEqual(got, want);
  });

  test(`${base}: 三個自埋異常都被抓到`, () => {
    const { truth, rep } = load(base);
    const a = truth.anomaly;
    const x = rep.entities.find((e) => e.taxId === a.margin_decline);
    assert.ok(x.marginAlert.length > 0, "毛利下滑客戶未被標示");
    const y = rep.overdueList[0];
    assert.equal(y.taxId, a.overdue_dup, "最大逾期客戶應為重複建檔的那家");
    assert.ok(y.codes.length >= 2, "逾期客戶應合併 2 組以上客戶代號");
    assert.ok(rep.belowCost.length >= 3);
  });
}

test("日期解析：西元 / 民國 / ISO / 無效", () => {
  const { parseDate } = clean;
  assert.equal(parseDate("2026/07/03"), "2026-07-03");
  assert.equal(parseDate("115/07/03"), "2026-07-03");
  assert.equal(parseDate("2026-07-03"), "2026-07-03");
  assert.equal(parseDate("１１５／０７／０３".replace(/／/g, "/")), "2026-07-03");
  assert.equal(parseDate(""), null);
  assert.equal(parseDate("2026/02/30"), undefined);
  assert.equal(parseDate("abc"), undefined);
});

test("數字解析：全形、千分位、空白、無效", () => {
  const { parseNum } = clean;
  assert.equal(parseNum("１２００"), 1200);
  assert.equal(parseNum("1,234"), 1234);
  assert.equal(parseNum(""), null);
  assert.ok(Number.isNaN(parseNum("12a")));
  assert.equal(parseNum("-50"), -50);
});

test("CSV：BOM、引號內逗號與換行、前導零保留為文字", () => {
  const rows = parseCSV('﻿A,B,C\r\n"1,234","x\ny",00123\r\n');
  assert.deepEqual(rows[0], ["A", "B", "C"]);
  assert.deepEqual(rows[1], ["1,234", "x\ny", "00123"]);
});

test("清洗：統編空白 / 缺成本 / 數量0且無單價 → 待處理；單價空白 → 回推", () => {
  const H = clean.HEADERS.join(",");
  const mk = (o) => {
    const base = { 單據日期: "2026/07/03", 訂單單號: "SO0001", 客戶代號: "C1", 客戶名稱: "甲", 統一編號: "01234567", 聯絡人: "", 聯絡電話: "", Email: "", 送貨地址: "", 業務員: "", 品號: "P1", 品名: "", 數量: "100", 單位: "PCS", 單價: "2", 單位成本: "1", 未稅金額: "200", 帳款到期日: "2026/08/03", 收款日期: "", 備註: "" };
    return clean.HEADERS.map((h) => (o[h] !== undefined ? o[h] : base[h])).join(",");
  };
  const csv = [H, mk({}), mk({ 統一編號: "" }), mk({ 單位成本: "" }), mk({ 數量: "0", 單價: "", 未稅金額: "0" }), mk({ 單價: "", 未稅金額: "300" })].join("\n");
  const { records } = clean.cleanRows(parseCSV(csv));
  assert.deepEqual(records.map((r) => r.status), ["ok", "pending", "pending", "pending", "ok"]);
  assert.equal(records[0].taxId, "01234567"); // 前導零保留
  assert.equal(records[4].price, 3); // 300 ÷ 100
});

test("計算：退貨沖減、收入為0 → 毛利率為 null、基準日之後不納入", () => {
  const H = clean.HEADERS.join(",");
  const row = (d, q, p, c, a, due, paid) => [d, "SO", "C1", "甲", "11111111", "", "", "", "", "", "P", "", q, "PCS", p, c, a, due, paid, ""].join(",");
  const csv = [H, row("2026/07/01", 100, 10, 6, 1000, "2026/07/31", ""), row("2026/07/05", -100, 10, 6, -1000, "2026/07/05", ""), row("2026/09/01", 10, 10, 6, 100, "", "")].join("\n");
  const { records } = clean.cleanRows(parseCSV(csv));
  const rep = calc.compute(records, "2026-07-31");
  assert.equal(rep.entities[0].revenue, 0);
  assert.equal(rep.entities[0].margin, null);
  assert.equal(rep.totals.rowsLate, 1);
  assert.equal(rep.overdueList.length, 0); // 正數 1000 的到期日=基準日，尚未逾期
});
