/* CSV 解析（瀏覽器與 Node 通用，無任何外部套件、無任何網路行為）
 * 支援：UTF-8 BOM、引號欄位、欄內逗號與換行、"" 跳脫、CRLF / LF / CR。
 */
(function (g) {
  const ERP = (g.ERP = g.ERP || {});

  function parseCSV(text) {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // BOM
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;
    let i = 0;
    const n = text.length;
    while (i < n) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          inQuotes = false;
          i++;
          continue;
        }
        field += ch;
        i++;
        continue;
      }
      if (ch === '"' && field === "") {
        inQuotes = true;
        i++;
      } else if (ch === ",") {
        row.push(field);
        field = "";
        i++;
      } else if (ch === "\r" || ch === "\n") {
        if (ch === "\r" && text[i + 1] === "\n") i++;
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
        i++;
      } else {
        field += ch;
        i++;
      }
    }
    if (field !== "" || row.length) {
      row.push(field);
      rows.push(row);
    }
    // 去掉整列皆空的列
    return rows.filter((r) => r.some((c) => c.trim() !== ""));
  }

  // 輸出 CSV 文字（欄內有逗號、引號、換行時加引號）。不含 BOM，由呼叫端決定。
  function stringifyCSV(rows) {
    const cell = (v) => {
      const s = v == null ? "" : String(v);
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
  }

  ERP.csv = { parseCSV, stringifyCSV };
  if (typeof module === "object" && module.exports) module.exports = ERP.csv;
})(typeof globalThis !== "undefined" ? globalThis : this);
