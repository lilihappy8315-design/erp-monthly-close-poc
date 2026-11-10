// 資料檢查與修正流程測試。執行：node --test tests/fix.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { parseCSV, stringifyCSV } = require("../src/csv.js");
const clean = require("../src/clean.js");
const calc = require("../src/calc.js");
const pseudo = require("../src/pseudo.js");

const file = path.join(__dirname, "..", "data", "synthetic_erp.csv");
const text = fs.readFileSync(file, "utf8");
const load = () => clean.cleanRows(parseCSV(text)).records;
const report = (recs) => calc.compute(recs, "2026-08-31");

test("CSV 輸出再解析，與原檔逐格相同（含逗號、引號、換行、前導零）", () => {
  const rows = [["a", "b,c", 'd"e', "f\ng", "00123", ""], ["1", "2", "3", "4", "5", "6"]];
  assert.deepEqual(parseCSV(stringifyCSV(rows)), rows);
  const orig = parseCSV(text);
  const out = parseCSV("﻿" + stringifyCSV(orig));
  assert.deepEqual(out, orig);
});

test("沒有任何修正時，輸出的修正後 CSV 內容與原檔一致（逐格）", () => {
  const recs = load();
  const rows = [clean.HEADERS, ...recs.map((r) => clean.KEYS.map((k) => r.raw[k]))];
  assert.deepEqual(parseCSV(stringifyCSV(rows)), parseCSV(text));
});

test("每個問題都帶有等級與可修正欄位；待處理的列至少有一個 block", () => {
  const recs = load();
  const pend = recs.filter((r) => r.status === "pending");
  assert.ok(pend.length >= 4);
  for (const r of pend) assert.ok(r.issues.some((i) => i.level === "block" && i.fields.length));
  const auto = recs.filter((r) => r.issues.some((i) => i.level === "auto"));
  assert.ok(auto.length > 10, "單價空白回推應有多列");
});

test("修正統編後：該列從待處理變成已納入，收入增加，並計入「人工修正」", () => {
  const recs = load();
  const before = report(recs);
  const target = recs.find((r) => r.status === "pending" && r.issues[0].code === "tax_blank");
  assert.ok(target);
  const expectedGain = target.amount != null ? target.amount : target.impact;
  // 補上一個既有客戶的統編 → 併入該法人
  const tax = recs.find((r) => r.status === "ok").taxId;
  assert.equal(clean.validateInput("taxId", tax), null);
  target.edits.push({ field: "taxId", from: target.raw.taxId, to: tax });
  target.raw.taxId = tax;
  recs[target.idx] = clean.reclean(target);
  const after = report(recs);
  assert.equal(recs[target.idx].status, "ok");
  assert.equal(after.totals.rowsPending, before.totals.rowsPending - 1);
  assert.equal(after.totals.rowsEdited, 1);
  assert.ok(Math.abs(after.totals.revenue - before.totals.revenue - expectedGain) < 0.01);
  assert.equal(after.entities.length, before.entities.length); // 併入既有法人，沒有多出新法人
});

test("補單位成本後才納入成本；確認不納入的列維持排除，補好後自動解除排除", () => {
  const recs = load();
  const t = recs.find((r) => r.issues.some((i) => i.code === "cost_bad"));
  t.excluded = true;
  recs[t.idx] = clean.reclean(t);
  assert.equal(recs[t.idx].status, "excluded");
  assert.equal(report(recs).totals.rowsExcluded, 1);
  assert.equal(report(recs).totals.rowsPending, load().filter((r) => r.status === "pending").length - 1);
  const t2 = recs[t.idx];
  t2.raw.cost = "5.5";
  t2.edits.push({ field: "cost", from: "", to: "5.5" });
  recs[t.idx] = clean.reclean(t2);
  assert.equal(recs[t.idx].status, "ok");
  assert.equal(recs[t.idx].excluded, false);
});

test("欄位修正前的格式檢查會擋下不合理的輸入", () => {
  const v = clean.validateInput;
  assert.ok(v("taxId", "123"));
  assert.equal(v("taxId", "０１２３４５６７"), null);
  assert.ok(v("date", "亂打"));
  assert.ok(v("date", ""));
  assert.equal(v("date", "115/07/03"), null);
  assert.equal(v("due", ""), null); // 到期日可以清空
  assert.ok(v("cost", "-3"));
  assert.ok(v("qty", "abc"));
  assert.equal(v("qty", "１２００"), null);
});

test("還原：把 raw 還原成 orig 後，狀態與最初完全相同", () => {
  const recs = load();
  const t = recs.find((r) => r.status === "pending");
  const first = JSON.stringify([t.status, t.problems]);
  t.raw.taxId = "12345678"; t.raw.cost = "1"; t.raw.qty = "10"; t.raw.date = "2026/07/01";
  const fixed = clean.reclean(t);
  const back = clean.reclean({ ...fixed, raw: { ...fixed.orig }, edits: [], excluded: false });
  assert.equal(JSON.stringify([back.status, back.problems]), first);
});

test("交接包的資料品質一行：只含筆數，不含原始值，且自我檢查仍通過", () => {
  const recs = load();
  const t = recs.find((r) => r.status === "pending");
  t.excluded = true; recs[t.idx] = clean.reclean(t);
  const rep = report(recs);
  const map = pseudo.buildMapping(rep);
  const pack = pseudo.buildPack(rep, map, { sizeMode: "band" });
  assert.match(pack, /資料品質：待處理 \d+ 列.*經人工修正 0 列；確認不納入 1 列/);
  assert.equal(pseudo.selfCheck(pack, recs).ok, true);
});
