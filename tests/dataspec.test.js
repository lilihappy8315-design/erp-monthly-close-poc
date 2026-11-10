// 守住題目「輸入規格」：每一份產生的假資料（含兩份自己的盲測檔）都必須真的包含這些情況，
// 而且網站的清洗核心要能正確吃下。執行：node --test tests/dataspec.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { parseCSV } = require("../src/csv.js");
const clean = require("../src/clean.js");
const calc = require("../src/calc.js");

const root = path.join(__dirname, "..");
const files = ["data/synthetic_erp", "data/blind_test_a", "data/blind_test_b"].filter((f) => fs.existsSync(path.join(root, f + ".csv")));

function validTax(s) {
  const w = [1, 2, 1, 2, 1, 2, 4, 1];
  let t = 0;
  for (let i = 0; i < 8; i++) { const p = Number(s[i]) * w[i]; t += Math.floor(p / 10) + (p % 10); }
  return t % 10 === 0 || (s[6] === "7" && (t + 1) % 10 === 0);
}

for (const base of files) {
  const buf = fs.readFileSync(path.join(root, base + ".csv"));
  const rows = parseCSV(buf.toString("utf8"));
  const H = rows[0].map((h) => h.trim());
  const R = rows.slice(1);
  const col = (name) => R.map((r) => r[H.indexOf(name)]);

  test(`${base}: 規模達標（>=300 筆、>=30 家法人、>=3 個月），欄位為題目的 20 欄`, () => {
    assert.deepEqual(H, clean.HEADERS);
    assert.ok(R.length >= 300);
    assert.ok(new Set(col("統一編號").filter(Boolean)).size >= 30);
    assert.ok(new Set(col("單據日期").map((d) => clean.parseDate(d).slice(0, 7))).size >= 3);
  });

  test(`${base}: ① UTF-8 且帶 BOM`, () => {
    assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  });

  test(`${base}: ② 西元與民國日期混用（含同一列內混用）`, () => {
    const d = col("單據日期");
    assert.ok(d.some((x) => /^\d{3}\//.test(x)), "缺民國年");
    assert.ok(d.some((x) => /^\d{4}\//.test(x)), "缺西元年");
    const style = (c) => (/^\d{3}\//.test(c) ? "roc" : /-/.test(c) ? "iso" : "ad");
    const mixed = R.filter((r) => new Set([r[0], r[17], r[18]].filter(Boolean).map(style)).size > 1);
    assert.ok(mixed.length > 0, "沒有同列混用");
  });

  test(`${base}: ③ 數量含全形數字，且清洗後數值正確`, () => {
    const fw = R.filter((r) => /[０-９]/.test(r[12]));
    assert.ok(fw.length > 0);
    for (const r of fw.slice(0, 5)) assert.equal(clean.parseNum(r[12]), Number(clean.toHalf(r[12])));
  });

  test(`${base}: ④ 統編、訂單單號、電話前導零：資料裡有，清洗後仍是原樣文字`, () => {
    const { records } = clean.cleanRows(rows);
    assert.ok(col("統一編號").some((t) => t.startsWith("0")), "缺 0 開頭統編");
    assert.ok(col("訂單單號").some((t) => /^0\d+$/.test(t)), "缺純數字且 0 開頭的訂單單號");
    assert.ok(col("聯絡電話").some((t) => t.startsWith("0")), "缺 0 開頭電話");
    for (const r of records) {
      assert.equal(r.orderNo, r.raw.orderNo.trim());
      if (r.raw.taxId) assert.equal(r.taxId, clean.toHalf(r.raw.taxId).trim());
      assert.equal(typeof r.orderNo, "string");
    }
    assert.ok(records.some((r) => /^0\d+$/.test(r.orderNo)), "單號前導零遺失");
    assert.ok(records.some((r) => r.taxId.startsWith("0")), "統編前導零遺失");
  });

  test(`${base}: ⑤ 統編檢查碼全部無效，且沒有任何列因此被刪除`, () => {
    const ts = new Set(col("統一編號").filter(Boolean));
    for (const t of ts) assert.equal(validTax(t), false, "出現檢查碼有效的統編 " + t);
    const { records } = clean.cleanRows(rows);
    assert.equal(records.length, R.length);
    const rep = calc.compute(records, calc.defaultBaseDate(records));
    assert.equal(rep.entities.length, ts.size);
  });

  test(`${base}: ⑥ 同統編有多個客戶代號與名稱寫法，網站合併為一家`, () => {
    const m = new Map();
    for (const r of R) {
      const t = r[4]; if (!t) continue;
      if (!m.has(t)) m.set(t, { c: new Set(), n: new Set() });
      m.get(t).c.add(r[2]); m.get(t).n.add(r[3].trim());
    }
    const dups = [...m.values()].filter((x) => x.c.size > 1 && x.n.size > 1);
    assert.ok(dups.length >= 3);
    const { records } = clean.cleanRows(rows);
    const rep = calc.compute(records, calc.defaultBaseDate(records));
    assert.ok(rep.entities.filter((e) => e.codes.length > 1).length >= 3);
    // 「重複建檔」家數必須等於：同統編有多個客戶代號或多種「非空白」名稱寫法的法人數（名稱空白的列不算一種寫法）
    const expected = [...m.values()].filter((x) => x.c.size > 1 || [...x.n].filter(Boolean).length > 1).length;
    assert.equal(rep.notes.merged, expected);
    for (const e of rep.entities) assert.ok(!e.names.includes(""), "名稱清單不應含空字串");
  });

  test(`${base}: ⑦ 單價空白，網站用 未稅金額÷數量 回推`, () => {
    const blank = R.filter((r) => r[14] === "" && r[16] !== "" && Number(clean.toHalf(r[12])) !== 0);
    assert.ok(blank.length > 0);
    const { records } = clean.cleanRows(rows);
    const rec = records.find((r) => r.raw.price === "" && r.status === "ok" && r.issues.some((i) => i.code === "price_backfilled"));
    assert.ok(rec);
    assert.ok(Math.abs(rec.price - rec.amount / rec.qty) < 1e-9);
  });

  test(`${base}: ⑧ 欄位值空白：至少 12 個不同欄位出現過空白，網站不當機且報表、交接包照常產生`, () => {
    const blankCols = H.filter((h, i) => R.some((r) => (r[i] || "") === ""));
    assert.ok(blankCols.length >= 12, "只有 " + blankCols.length + " 欄出現過空白：" + blankCols.join("、"));
    for (const must of ["聯絡人", "聯絡電話", "Email", "送貨地址", "業務員", "品名", "客戶名稱"]) assert.ok(blankCols.includes(must), "缺空白案例：" + must);
    const { records } = clean.cleanRows(rows);
    const report = calc.compute(records, calc.defaultBaseDate(records));
    const pseudo = require("../src/pseudo.js");
    const map = pseudo.buildMapping(report);
    const pack = pseudo.buildPack(report, map, { sizeMode: "band" });
    assert.ok(pack.length > 500);
    assert.equal(pseudo.selfCheck(pack, records).ok, true);
    for (const e of report.entities) assert.ok(e.name && e.name.length > 0, "法人名稱不得為空字串");
  });
}
