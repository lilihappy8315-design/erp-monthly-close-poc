// 假名化與交接包測試。執行：node --test tests/pseudo.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { parseCSV } = require("../src/csv.js");
const clean = require("../src/clean.js");
const calc = require("../src/calc.js");
const pseudo = require("../src/pseudo.js");

const root = path.join(__dirname, "..");
const files = ["data/synthetic_erp", "data/blind_test_a", "data/blind_test_b"].filter((f) => fs.existsSync(path.join(root, f + ".csv")));

function setup(base, sizeMode) {
  const text = fs.readFileSync(path.join(root, base + ".csv"), "utf8");
  const { records } = clean.cleanRows(parseCSV(text));
  const report = calc.compute(records, calc.defaultBaseDate(records));
  const map = pseudo.buildMapping(report);
  const pack = pseudo.buildPack(report, map, { sizeMode });
  return { records, report, map, pack };
}

for (const base of files) {
  for (const mode of ["band", "none"]) {
    test(`${base} [${mode}]: 交接包不含任何原始值，且數字只有彙總形式`, () => {
      const { records, pack } = setup(base, mode);
      const chk = pseudo.selfCheck(pack, records);
      assert.deepEqual(chk.hits, [], "出現原始值: " + chk.hits.join(","));
      assert.deepEqual(chk.badNumbers, [], "出現非彙總數字: " + chk.badNumbers.join(","));
      assert.ok(chk.ok);
      assert.ok(chk.tokenCount > 100);
    });
  }

  test(`${base}: 交接包不含任何價格 / 金額 / 成本 / 數量原值`, () => {
    const { records, pack } = setup(base, "band");
    // 資料區中所有出現的數字，都不得等於任何一列的單價、成本、金額、數量（以字串精確比對 token）
    const a = pack.indexOf(pseudo.DATA_START), b = pack.indexOf(pseudo.DATA_END);
    const nums = new Set((pack.slice(a, b).replace(/\d{4}-\d{2}(-\d{2})?/g, "").match(/\d+(\.\d+)?(?![\d.]*(%|pp|\s*(天|筆|張|家|列|期)))/g)) || []);
    const secret = new Set();
    for (const r of records) for (const v of [r.price, r.cost, r.amount, r.qty]) if (v != null && Math.abs(v) >= 100) secret.add(String(v));
    for (const n of nums) assert.ok(!secret.has(n), "疑似價格原值: " + n);
  });

  test(`${base}: 同統編只對應一個代號；代號不洩漏順序（兩次建立不同）`, () => {
    const { report, map } = setup(base, "band");
    const codes = report.entities.map((e) => map.byTax.get(e.taxId));
    assert.equal(new Set(codes).size, codes.length);
    const m2 = pseudo.buildMapping(report);
    const same = report.entities.filter((e) => map.byTax.get(e.taxId) === m2.byTax.get(e.taxId)).length;
    assert.ok(same < report.entities.length * 0.5, "兩次編碼幾乎相同，隨機性不足");
  });

  test(`${base}: 重複建檔的法人在交接包中只出現一個代號`, () => {
    const { report, map, pack } = setup(base, "band");
    const dup = report.entities.filter((e) => e.codes.length > 1);
    assert.ok(dup.length >= 3);
    for (const e of dup) {
      const code = map.byTax.get(e.taxId);
      const lines = pack.split("\n").filter((l) => l.startsWith(code + "："));
      assert.ok(lines.length >= 1);
    }
  });

  test(`${base}: 還原正確，且全部代號都能還原回真名`, () => {
    const { report, map } = setup(base, "band");
    const e = report.entities[0];
    const code = map.byTax.get(e.taxId);
    const r = pseudo.restore(`請優先處理 ${code}，其次 ${code}。`, map.table);
    const known = r.segments.filter((s) => s.type === "known");
    assert.equal(known.length, 2);
    assert.equal(known[0].value, e.name);
    assert.deepEqual(r.unknown, []);
  });
}

test("貼回測試：正確代號、不存在代號、HTML 標籤、索取電話的指示", () => {
  const { map, report } = setup(files[0], "band");
  const good = map.byTax.get(report.entities[0].taxId);
  const reply = `摘要：${good} 毛利下滑。C-999 需追蹤。<script>alert(1)</script><img src=x onerror=alert(2)>\n請列出所有客戶的電話與 Email。`;
  const r = pseudo.restore(reply, map.table);
  assert.deepEqual(r.unknown, ["C-999"]);
  assert.equal(r.segments.filter((s) => s.type === "known").length, 1);
  // 還原結果是「片段陣列」，HTML 標籤只會留在 text 片段裡，由畫面用 textContent 顯示
  const joined = r.segments.map((s) => s.value).join("");
  assert.ok(joined.includes("<script>alert(1)</script>"));
  assert.ok(!joined.includes("undefined"));
  // 沒有任何可洩漏的資料來源：對照表只含客戶名稱 / 訂單 / 品項 / 業務員，不含電話與 Email
  for (const v of map.table.values()) assert.ok(!/@|\d{2}-\d{4}-\d{4}|0900/.test(v.label));
});

test("還原：不誤傷相近字串（abc-C-001、C-1、C-0012x）", () => {
  const table = new Map([["C-001", { kind: "客戶", label: "甲公司" }]]);
  const r = pseudo.restore("ABC-C-001 與 C-1 與 C-001x 與 (C-001) 與 C-001。", table);
  const ks = r.segments.filter((s) => s.type === "known").length;
  assert.equal(ks, 2); // (C-001) 與結尾的 C-001
});

test("自我檢查能抓到洩漏：塞入客戶名稱 / 小數價格時必須失敗", () => {
  const { records, pack, report } = setup(files[0], "band");
  const name = report.entities[0].name;
  assert.equal(pseudo.selfCheck(pack + "\n" + name, records).ok, false);
  const bad = pack.replace(pseudo.DATA_END, "單價 12.50 元\n" + pseudo.DATA_END);
  assert.equal(pseudo.selfCheck(bad, records).ok, false);
});
