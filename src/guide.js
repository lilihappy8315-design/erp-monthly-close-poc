/* 操作引導：依目前狀態，算出「現在在第幾步、下一步要按哪裡、提示文字」。
 * 這是純函式（不碰畫面、不碰網路），方便自動測試每個狀況的提示是否正確。
 */
(function (g) {
  const ERP = (g.ERP = g.ERP || {});

  const STEPS = [
    { id: 1, name: "上傳檔案", anchor: "sec-upload" },
    { id: 2, name: "檢查資料", anchor: "sec-status" },
    { id: 3, name: "看報表", anchor: "sec-report" },
    { id: 4, name: "交給 AI", anchor: "sec-pack" },
    { id: 5, name: "貼回還原", anchor: "sec-restore" },
  ];

  /* s: {
   *   hasFile, blockCount, skipped（先略過資料檢查）, reportSeen, copied（按過複製）,
   *   replyFilled（貼回框有內容）, restored（按過還原）, packOk（交接包自動檢查通過）
   * } */
  function nextStep(s) {
    const d4 = !!(s.hasFile && (s.copied || s.replyFilled || s.restored));
    const d3 = !!(s.hasFile && (s.reportSeen || d4));
    const d2 = !!(s.hasFile && (s.blockCount === 0 || s.skipped || d3));
    const done = [!!s.hasFile, d2, d3, d4, !!(s.hasFile && s.restored)];
    const cur = done.findIndex((x) => !x) + 1; // 1..5；全部完成為 0
    const current = cur === 0 ? 6 : cur;

    const out = { done, current, tone: "normal", target: null, actions: [], msg: "" };
    const go = (label) => ({ id: "go", label: label || "帶我去" });

    if (current === 1) {
      out.msg = "第一步：把 ERP 匯出的訂單明細 CSV 拖進來，或按「選擇 CSV 檔」。檔案只在你的瀏覽器裡處理，不會上傳。";
      out.target = { id: "pickBtn", kind: "button", hint: "按這裡選檔案" };
      out.actions = [go()];
    } else if (current === 2) {
      out.msg = `有 ${s.blockCount} 列資料缺少必要欄位，目前沒有納入計算。可以先補上，也可以先看報表。`;
      out.target = { id: "issues", kind: "section", hint: "" };
      out.actions = [go("帶我去處理"), { id: "skip", label: "先看報表" }];
    } else if (current === 3) {
      out.msg = s.blockCount === 0 && !s.skipped
        ? "資料沒有問題。往下看月結報表：毛利異常、逾期帳款、低於成本的訂單。"
        : "往下看月結報表：毛利異常、逾期帳款、低於成本的訂單。";
      out.target = { id: "sec-report", kind: "section", hint: "" };
      out.actions = [go("帶我去看報表"), { id: "seen", label: "我看完了，下一步" }];
    } else if (current === 4) {
      if (s.packOk === false) {
        out.tone = "warn";
        out.msg = "交接包的自動檢查沒有通過，請先不要複製。";
        out.target = { id: "sec-pack", kind: "section", hint: "" };
        out.actions = [go()];
      } else {
        out.msg = "按「複製交接包」，貼到公司核准的 AI 工具。交接包裡只有代號和比例，沒有名稱和價格。";
        out.target = { id: "copy", kind: "button", hint: "按這裡複製" };
        out.actions = [go()];
      }
    } else if (current === 5) {
      if (!s.replyFilled) {
        out.msg = "已複製。到 AI 工具貼上，拿到回覆後回到這裡，把整段回覆貼到下面的框裡。";
        out.target = { id: "replyWrap", kind: "button", hint: "貼上 AI 的回覆" };
      } else {
        out.msg = "按「還原代號」，回覆裡的代號會換回真正的客戶名稱。";
        out.target = { id: "doRestore", kind: "button", hint: "按這裡還原" };
      }
      out.actions = [go()];
    } else {
      out.msg = "完成了。需要的話可以下載修正後 CSV；用完請按「清除畫面上的資料」。";
      out.target = { id: "reset", kind: "button", hint: "用完請清除" };
      out.actions = [go()];
    }
    return out;
  }

  ERP.guide = { STEPS, nextStep };
  if (typeof module === "object" && module.exports) module.exports = ERP.guide;
})(typeof globalThis !== "undefined" ? globalThis : this);
