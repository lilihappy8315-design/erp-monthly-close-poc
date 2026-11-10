// 操作引導的狀態判斷測試。執行：node --test tests/guide.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { nextStep } = require("../src/guide.js");

const base = { hasFile: false, blockCount: 0, skipped: false, reportSeen: false, copied: false, replyFilled: false, restored: false, packOk: true };
const S = (o) => nextStep({ ...base, ...o });

test("還沒上傳：指向選擇檔案按鈕，後面的步驟都沒完成", () => {
  const r = S({});
  assert.equal(r.current, 1);
  assert.equal(r.target.id, "pickBtn");
  assert.deepEqual(r.done, [false, false, false, false, false]);
});

test("已上傳且有待處理：停在第 2 步，可處理或略過", () => {
  const r = S({ hasFile: true, blockCount: 4 });
  assert.equal(r.current, 2);
  assert.match(r.msg, /4 列/);
  assert.deepEqual(r.actions.map((a) => a.id), ["go", "skip"]);
  assert.equal(r.target.id, "issues");
});

test("略過資料檢查後：進到第 3 步看報表", () => {
  const r = S({ hasFile: true, blockCount: 4, skipped: true });
  assert.equal(r.current, 3);
  assert.equal(r.done[1], true);
  assert.equal(r.target.id, "sec-report");
});

test("沒有待處理資料：資料檢查自動完成，直接到第 3 步", () => {
  const r = S({ hasFile: true, blockCount: 0 });
  assert.equal(r.current, 3);
  assert.deepEqual(r.done, [true, true, false, false, false]);
});

test("看完報表：指向複製交接包", () => {
  const r = S({ hasFile: true, reportSeen: true });
  assert.equal(r.current, 4);
  assert.equal(r.target.id, "copy");
});

test("交接包自動檢查失敗：警告，不鼓勵複製", () => {
  const r = S({ hasFile: true, reportSeen: true, packOk: false });
  assert.equal(r.tone, "warn");
  assert.notEqual(r.target.id, "copy");
});

test("按過複製：指向貼回框；貼上內容後：指向還原按鈕", () => {
  let r = S({ hasFile: true, reportSeen: true, copied: true });
  assert.equal(r.current, 5);
  assert.equal(r.target.id, "replyWrap");
  r = S({ hasFile: true, reportSeen: true, copied: true, replyFilled: true });
  assert.equal(r.target.id, "doRestore");
});

test("還原完成：全部打勾，提示清除資料", () => {
  const r = S({ hasFile: true, reportSeen: true, copied: true, replyFilled: true, restored: true });
  assert.equal(r.current, 6);
  assert.deepEqual(r.done, [true, true, true, true, true]);
  assert.equal(r.target.id, "reset");
});

test("跳著做：沒複製就先貼回覆，不會叫使用者回頭複製", () => {
  const r = S({ hasFile: true, blockCount: 2, replyFilled: true });
  assert.equal(r.current, 5);
  assert.equal(r.done[3], true);
  assert.equal(r.target.id, "doRestore");
});

test("沒有檔案時，即使旗標殘留也一律回到第 1 步", () => {
  const r = S({ hasFile: false, reportSeen: true, copied: true, restored: true });
  assert.equal(r.current, 1);
  assert.deepEqual(r.done, [false, false, false, false, false]);
});

test("每個有目標的提示都至少有一個動作；目標為 button 的都有提示文字", () => {
  const states = [{}, { hasFile: true, blockCount: 1 }, { hasFile: true }, { hasFile: true, reportSeen: true },
    { hasFile: true, copied: true }, { hasFile: true, copied: true, replyFilled: true }, { hasFile: true, restored: true }];
  for (const st of states) {
    const r = S(st);
    if (r.target) {
      assert.ok(r.actions.length >= 1);
      if (r.target.kind === "button") assert.ok(r.target.hint.length > 0);
    }
  }
});
