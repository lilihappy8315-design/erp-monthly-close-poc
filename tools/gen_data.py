#!/usr/bin/env python3
"""
虛構 ERP「訂單明細」匯出檔產生器（所有資料皆為隨機捏造，與任何真實公司、個人無關）。

用法：
    python tools/gen_data.py                       # 預設種子，輸出 data/synthetic_erp.csv
    python tools/gen_data.py --seed 7 --out data/blind_test_a.csv
同一個 --seed 一定產生同一份檔案，方便別人重跑與比對。

輸出：
    <out>.csv            ERP 匯出檔（UTF-8 含 BOM，20 欄，混入髒資料）
    <out>.truth.json     腳本用「乾淨資料」獨立算出的標準答案（供測試比對 JS 計算結果）
    <out>.answer.md      自埋的髒資料與業務異常清單（驗收答案）
"""
import argparse
import collections
import csv
import datetime as dt
import json
import os
import random
import re

HEADERS = ["單據日期", "訂單單號", "客戶代號", "客戶名稱", "統一編號", "聯絡人", "聯絡電話", "Email",
           "送貨地址", "業務員", "品號", "品名", "數量", "單位", "單價", "單位成本", "未稅金額",
           "帳款到期日", "收款日期", "備註"]

MONTHS = [(2026, 5), (2026, 6), (2026, 7), (2026, 8)]
FW = str.maketrans("0123456789", "０１２３４５６７８９")


# ---------- 工具 ----------
def valid_tax(s):
    """統編檢查碼是否有效（我們要刻意產生『無效』的）。"""
    w = [1, 2, 1, 2, 1, 2, 4, 1]
    total = 0
    for ch, wt in zip(s, w):
        p = int(ch) * wt
        total += p // 10 + p % 10
    if total % 10 == 0:
        return True
    return s[6] == "7" and (total + 1) % 10 == 0


def gen_tax_id(rng, used, leading_zero=False):
    while True:
        s = "".join(rng.choice("0123456789") for _ in range(8))
        if leading_zero:
            s = "0" + s[1:]
        elif s[0] == "0":
            continue
        if not valid_tax(s) and s not in used:
            used.add(s)
            return s


def fmt_date(d, rng, style=None):
    style = style or rng.choices(["ad", "roc", "iso"], weights=[70, 22, 8])[0]
    if style == "roc":
        return f"{d.year - 1911}/{d.month:02d}/{d.day:02d}"
    if style == "iso":
        return d.isoformat()
    return f"{d.year}/{d.month:02d}/{d.day:02d}"


def month_end(y, m):
    nxt = dt.date(y + (m == 12), m % 12 + 1, 1)
    return nxt - dt.timedelta(days=1)


# ---------- 主程式 ----------
def build(seed):
    rng = random.Random(seed)

    # --- 品項 ---
    kinds = ["六角螺栓", "十字沉頭螺絲", "內六角螺絲", "自攻螺絲", "平墊圈", "六角螺帽",
             "膨脹螺絲", "木螺絲", "止付螺絲", "彈簧墊圈", "牙條", "鉚釘"]
    sizes = ["M3x10", "M4x16", "M5x20", "M6x30", "M8x40", "M10x50"]
    combos = [(k, s) for k in kinds for s in sizes]
    rng.shuffle(combos)
    skus = []
    for i, (k, s) in enumerate(combos[:23]):
        skus.append({"code": f"S{i + 1:04d}", "name": f"{k} {s}",
                     "cost": round(rng.uniform(0.3, 12), 2), "markup": rng.uniform(0.24, 0.42)})
    special = {"code": "S0099", "name": "特殊合金內六角螺絲 M8x40", "cost": 6.80, "markup": 0.35}
    skus.append(special)

    # --- 客戶（法人）---
    used_tax = set()
    surn = "陳林黃張李王吳劉蔡楊"
    syl = "旭恆宏鼎磊崴昇禾騰鉅晟嘉岳森泰昱睿豐鑫勝達"
    suffix = ["五金股份有限公司", "螺絲實業有限公司", "機械工業股份有限公司", "精密科技有限公司", "企業有限公司"]
    n_ent = 36
    zero_lead = set(rng.sample(range(n_ent), 4))
    reps = ["測試業務甲", "測試業務乙", "測試業務丙", "測試業務丁"]
    names_used = set()
    ents = []
    for i in range(n_ent):
        while True:
            a, b = rng.choice(syl), rng.choice(syl)
            if a != b and (a + b) not in names_used:
                names_used.add(a + b)
                break
        ents.append({
            "idx": i, "short": f"{a}{b}測試", "full": f"{a}{b}測試{rng.choice(suffix)}",
            "tax": gen_tax_id(rng, used_tax, i in zero_lead),
            "contact": f"{rng.choice(surn)}測試{'一二三四五六七八九'[rng.randrange(9)]}",
            "phone": f"02-5550-{i + 1:04d}" if i % 3 else f"0900-000-{i + 1:03d}",
            "email": f"buyer{i + 1}@{chr(97 + i % 26)}{i + 1}test.example",
            "addr": f"測試市範例區虛構路{rng.randint(1, 300)}號",
            "rep": rng.choice(reps), "terms": rng.choice([30, 45, 60]),
            "size": rng.choice(["s", "s", "m", "m", "m", "b"]),
            "codes": [f"C{i + 1:04d}"], "names": [None],
            "cust_factor": rng.uniform(0.97, 1.03),
        })
        ents[-1]["names"] = [ents[-1]["full"]]

    # --- 自埋異常的客戶挑選 ---
    pool = list(range(n_ent))
    rng.shuffle(pool)
    X, Y, Z = pool[0], pool[1], pool[2]          # 毛利下滑 / 逾期（且重複建檔）/ 大額退貨
    dup_idx = {Y} | set(pool[3:5])               # 3 家重複建檔（Y 在內）
    extra_code = n_ent
    for i in sorted(dup_idx):
        extra_code += 1
        e = ents[i]
        e["codes"].append(f"C{extra_code:04d}")
        # 不同寫法：簡稱 / 舊名加註
        e["names"].append(e["short"] + ("五金" if i % 2 else "（舊）"))
    for i in (X, Y, Z):
        ents[i]["size"] = "b"
    ents[Y]["terms"] = 30

    # --- 產生訂單 ---
    base_date = month_end(*MONTHS[-1])
    price_mf = {X: {5: 1.00, 6: 0.94, 7: 0.88, 8: 0.80}}   # X 客戶逐月降價 => 毛利下滑
    orders = []

    def make_line(e, sku, month, rep, below_cost=False):
        cost = sku["cost"]
        mf = price_mf.get(e["idx"], {}).get(month, 1.0)
        price = round(cost * (1 + sku["markup"]) * e["cust_factor"] * mf, 2)
        if below_cost:
            price = round(cost * 0.88, 2)
        if cost < 1:
            qty = rng.randrange(5000, 60001, 100)
        elif cost < 4:
            qty = rng.randrange(1000, 20001, 100)
        else:
            qty = rng.randrange(200, 5001, 50)
        qty = int(qty * {"s": 0.6, "m": 1.0, "b": 1.6}[e["size"]]) // 50 * 50 or 50
        return {"sku": sku, "qty": qty, "price": price, "cost": cost}

    for e in ents:
        for (y, m) in MONTHS:
            n = {"b": rng.choice([3, 4, 5]), "m": rng.choice([2, 3]), "s": rng.choice([0, 1, 1, 2])}[e["size"]]
            for _ in range(n):
                day = rng.randint(1, month_end(y, m).day)
                ci = rng.randrange(len(e["codes"]))
                orders.append({"ent": e, "date": dt.date(y, m, day), "ci": ci, "rep": e["rep"],
                               "lines": [make_line(e, rng.choice(skus[:-1]), m, e["rep"])
                                         for _ in range(rng.choice([1, 2, 2, 3]))]})

    # 低於成本：特殊合金螺絲，由「測試業務丙」在 7、8 月低價出貨給 3 家客戶
    bc_ents = rng.sample([e for e in ents if e["idx"] not in (X, Y, Z)], 3)
    for e in bc_ents:
        for m in (7, 8):
            orders.append({"ent": e, "date": dt.date(2026, m, rng.randint(3, 25)), "ci": 0, "rep": "測試業務丙",
                           "lines": [make_line(e, special, m, "測試業務丙", below_cost=True)
                                     for _ in range(rng.choice([1, 2]))]})

    orders.sort(key=lambda o: o["date"])
    for i, o in enumerate(orders, 1):
        # 約 25% 的訂單用純數字、0 開頭的單號（測試前導零是否被保留）
        o["no"] = f"00{o['date']:%y%m}{i:04d}" if rng.random() < 0.25 else f"SO{o['date']:%y%m}{i:04d}"

    # --- 付款狀態 ---
    for o in orders:
        e = o["ent"]
        o["due"] = o["date"] + dt.timedelta(days=e["terms"])
        if e["idx"] == Y and o["date"].month <= 7:
            o["paid"] = None                                   # Y 客戶 5~7 月全未收
        elif o["due"] > base_date:
            o["paid"] = None if rng.random() < 0.6 else o["due"] + dt.timedelta(days=rng.randint(-3, 12))
        else:
            o["paid"] = None if rng.random() < 0.06 else o["due"] + dt.timedelta(days=rng.randint(-5, 15))
        if o["paid"] and o["paid"] < o["date"]:
            o["paid"] = o["date"]

    # --- 展開成列（乾淨版）---
    remarks_pool = ["", "", "", "", "", "", "急單", "客戶要求提早出貨",
                    "聯絡採購 林測試 0900-000-123 確認交期", "特價專案，議價 3.2 元，勿告知其他客戶",
                    "月結60天，老闆口頭同意", "匯款帳號 000-00000-00000（虛構）", "含運費由我方吸收",
                    "品質抱怨，客戶要求折讓"]
    rows = []
    for o in orders:
        e = o["ent"]
        for ln in o["lines"]:
            rows.append({
                "date": o["date"], "no": o["no"], "code": e["codes"][o["ci"]], "name": e["names"][o["ci"]],
                "tax": e["tax"], "contact": e["contact"], "phone": e["phone"], "email": e["email"],
                "addr": e["addr"], "rep": o["rep"], "sku": ln["sku"]["code"], "sname": ln["sku"]["name"],
                "qty": ln["qty"], "unit": "PCS", "price": ln["price"], "cost": ln["cost"],
                "amount": int(round(ln["qty"] * ln["price"])), "due": o["due"], "paid": o["paid"],
                "remark": rng.choice(remarks_pool), "ent": e["idx"], "flags": [],
            })

    # --- Z 客戶 7 月大額退貨（負數列）+ 其他零星退貨 ---
    z_rows = [r for r in rows if r["ent"] == Z and r["date"].month == 6]
    ret_src = sorted(z_rows, key=lambda r: -r["amount"])[:2] + rng.sample(rows, 2)
    for k, src in enumerate(ret_src):
        r = dict(src)
        d = dt.date(2026, 7, rng.randint(5, 28)) if k < 2 else dt.date(2026, 8, rng.randint(5, 28))
        big = k < 2
        r.update({"date": d, "no": f"RT{d:%y%m}{k + 1:04d}", "qty": -(src["qty"] if big else src["qty"] // 4),
                  "due": d, "paid": None, "remark": "退貨：尺寸不符" if big else "退貨"})
        r["amount"] = int(round(r["qty"] * r["price"]))
        r["flags"] = ["return"]
        rows.append(r)

    rows.sort(key=lambda r: (r["date"], r["no"]))

    # --- 刻意製造「待處理」列（不納入計算）---
    plain = [r for r in rows if r["ent"] not in (X, Y, Z) and "return" not in r["flags"] and r["qty"] > 0]
    pick = rng.sample(plain, 6)
    pick[0]["tax"] = ""; pick[0]["flags"].append("tax_blank")           # 統編空白 x2
    pick[1]["tax"] = ""; pick[1]["flags"].append("tax_blank")
    pick[2]["cost"] = None; pick[2]["flags"].append("cost_blank")       # 缺單位成本
    zero = dict(pick[3]); zero.update({"qty": 0, "amount": 0, "price": None, "no": pick[3]["no"],
                                       "flags": ["zero_qty_no_price"], "remark": "數量填 0 未補單價"})
    rows.append(zero)
    pick[4]["due"] = None; pick[4]["flags"].append("due_blank")         # 到期日空白（不能判斷逾期，仍計收入）
    pick[5]["flags"].append("amount_blank")
    pick[5]["amount"] = round(pick[5]["qty"] * pick[5]["price"], 2)      # 回推值 = 數量×單價（保留兩位小數）                              # 未稅金額空白，可用 數量×單價 回推

    def pending(r):
        return any(f in r["flags"] for f in ("tax_blank", "cost_blank", "zero_qty_no_price"))

    # --- 獨立算標準答案（用乾淨值）---
    truth_rows = [r for r in rows if not pending(r) and r["date"] <= base_date]
    ent_tax = {e["idx"]: e["tax"] for e in ents}
    per = {}
    for r in truth_rows:
        t = ent_tax[r["ent"]]
        d = per.setdefault(t, {"months": {}, "overdue_amount": 0, "max_overdue_days": 0, "overdue_lines": 0})
        mk = f"{r['date']:%Y-%m}"
        mo = d["months"].setdefault(mk, {"revenue": 0, "cost": 0.0})
        mo["revenue"] = round(mo["revenue"] + r["amount"], 2)
        mo["cost"] += r["qty"] * r["cost"]
        unpaid = r["paid"] is None or r["paid"] > base_date
        if r["qty"] > 0 and r["due"] and unpaid and r["due"] < base_date:
            d["overdue_amount"] += r["amount"]
            d["overdue_lines"] += 1
            d["max_overdue_days"] = max(d["max_overdue_days"], (base_date - r["due"]).days)
    for d in per.values():
        for mo in d["months"].values():
            mo["cost"] = round(mo["cost"], 2)
            mo["margin"] = None if mo["revenue"] == 0 else round((mo["revenue"] - mo["cost"]) / mo["revenue"], 6)
    below = sorted((r["no"], r["sku"]) for r in truth_rows if r["qty"] > 0 and r["price"] is not None and r["price"] < r["cost"])
    truth = {
        "base_date": base_date.isoformat(),
        "total_revenue": round(sum(r["amount"] for r in truth_rows), 2),
        "total_cost": round(sum(r["qty"] * r["cost"] for r in truth_rows), 2),
        "overdue_total": sum(d["overdue_amount"] for d in per.values()),
        "entities": per,
        "below_cost_lines": [list(x) for x in below],
        "pending_count": sum(1 for r in rows if pending(r)),
        "entity_count": len(per),
        "tax_by_name": {e["full"]: e["tax"] for e in ents},
        "anomaly": {"margin_decline": ents[X]["tax"], "overdue_dup": ents[Y]["tax"], "big_return": ents[Z]["tax"],
                    "dup_entities": [ents[i]["tax"] for i in sorted(dup_idx)]},
    }
    return rng, rows, ents, truth, dict(X=X, Y=Y, Z=Z, dup=sorted(dup_idx), bc=[e["idx"] for e in bc_ents]), base_date


def dirtify(rows, rng):
    """把乾淨值轉成 ERP 匯出的髒文字。空白欄位用固定間隔挑列，確保每種都一定出現且可重現。"""
    out = []
    cnt = collections.Counter(r["ent"] for r in rows)
    for k, r in enumerate(rows):
        style = rng.choices(["ad", "roc", "iso"], weights=[70, 22, 8])[0]
        qty = str(r["qty"])
        if rng.random() < 0.06:
            qty = qty.translate(FW)                                  # 全形數字
        price = "" if (r["price"] is None or rng.random() < 0.04) else f"{r['price']:.2f}"
        amount = f"{r['amount']:,}" if (abs(r["amount"]) >= 1000 and rng.random() < 0.15) else str(r["amount"])
        if "amount_blank" in r["flags"]:
            amount = ""
        name = r["name"]
        if rng.random() < 0.03:
            name = f" {name} "                                       # 前後空白
        if k % 149 == 23 and cnt[r["ent"]] >= 6 and r["tax"]:
            name = ""                                                # 客戶名稱空白（同法人其他列仍有名稱）
        email = r["email"].upper() if rng.random() < 0.05 else r["email"]
        below = (r["price"] is not None and r["cost"] is not None and r["qty"] > 0 and r["price"] < r["cost"])
        contact = "" if k % 53 == 5 else r["contact"]
        phone = "" if k % 61 == 7 else r["phone"]
        email = "" if k % 67 == 11 else email
        addr = "" if k % 71 == 13 else r["addr"]
        rep_ = "" if k % 59 == 17 else r["rep"]
        sname = "" if k % 43 == 19 else r["sname"]
        sku = "" if (k % 89 == 31 and not below) else r["sku"]       # 品號空白（避開低於成本列，標準答案以品號比對）
        unit = "" if k % 97 == 3 else r["unit"]
        out.append([
            fmt_date(r["date"], rng, style), r["no"], r["code"], name, r["tax"], contact, phone,
            email, addr, rep_, sku, sname, qty, unit, price,
            "" if r["cost"] is None else f"{r['cost']:.2f}", amount,
            "" if r["due"] is None else fmt_date(r["due"], rng),      # 到期日、收款日各自隨機格式 => 同一列內也會混用
            "" if r["paid"] is None else fmt_date(r["paid"], rng), r["remark"],
        ])
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=20261109)
    ap.add_argument("--out", default="data/synthetic_erp.csv")
    a = ap.parse_args()

    rng, rows, ents, truth, picks, base_date = build(a.seed)
    # 價格若為空，標準答案仍以乾淨值計；髒資料用另一個亂數流，避免影響上面的生成
    drng = random.Random(a.seed + 1)
    data = dirtify(rows, drng)

    os.makedirs(os.path.dirname(a.out) or ".", exist_ok=True)
    with open(a.out, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f, lineterminator="\r\n")
        w.writerow(HEADERS)
        w.writerows(data)
    base = os.path.splitext(a.out)[0]
    with open(base + ".truth.json", "w", encoding="utf-8") as f:
        json.dump(truth, f, ensure_ascii=False, indent=1)

    col = {h: i for i, h in enumerate(HEADERS)}
    blank_cols = {h: sum(1 for r in data if r[i] == "") for h, i in col.items()}
    blank_cols = {h: n for h, n in blank_cols.items() if n}
    lead_orders = len({r[1] for r in data if re.fullmatch(r"0\d+", r[1])})
    style_of = lambda c: "roc" if re.match(r"\d{3}/", c) else "iso" if "-" in c else "ad"
    mixed_rows = sum(1 for r in data if len({style_of(c) for c in (r[0], r[17], r[18]) if c}) > 1)
    fw_rows = sum(1 for r in data if re.search("[０-９]", r[col["數量"]]))

    nm = lambda i: f"{ents[i]['full']}（統編 {ents[i]['tax']}）"
    with open(base + ".answer.md", "w", encoding="utf-8") as f:
        f.write(f"# 驗收答案（種子 {a.seed}，結帳基準日 {base_date}）\n\n")
        f.write("> 全部為虛構測試資料。以下是產生器刻意埋入的狀況，供自我驗收。\n\n")
        f.write(f"資料量：{len(data)} 列、{len(ents)} 家法人（{len(ents) + len(picks['dup'])} 組客戶代號）、4 個月。\n\n")
        f.write("## 三個業務異常\n\n")
        xm = truth["entities"][ents[picks["X"]]["tax"]]["months"]
        trend = " → ".join(f"{v['margin'] * 100:.1f}%" for _, v in sorted(xm.items()))
        f.write(f"1. 毛利逐月下滑：{nm(picks['X'])}，單價逐月調降 0%、6%、12%、20%，毛利率 {trend}。\n")
        f.write(f"2. 帳款嚴重逾期且重複建檔：{nm(picks['Y'])}，5 到 7 月全部未收，且分散在 2 組客戶代號，不合併就看不出全貌。\n")
        f.write(f"3. 低於成本出貨：品號 S0099「特殊合金內六角螺絲」由「測試業務丙」在 7、8 月以約 88% 成本價賣給 "
                + "、".join(ents[i]['short'] for i in picks['bc']) + f"，共 {len(truth['below_cost_lines'])} 筆明細。\n")
        f.write(f"4. 另外：{nm(picks['Z'])} 在 7 月有兩筆大額退貨（負數列），當月毛利與收入被沖減。\n\n")
        f.write("## 埋入的髒資料\n\n")
        f.write("| # | 髒資料 | 說明 | 期待系統行為 |\n|---|---|---|---|\n")
        f.write(f"| 1 | 日期格式混用 | 西元 2026/07/03、民國 115/07/03、ISO 2026-07-03 混在同一檔；其中 {mixed_rows} 列在同一列內就混用不同格式 | 全部正確轉換 |\n")
        f.write(f"| 2 | 全形數字 | {fw_rows} 列的數量是全形（例：１２００） | 轉半形後計算 |\n")
        f.write("| 3 | 檔案帶 BOM | UTF-8 BOM 開頭 | 第一欄欄名不得變成亂碼 |\n")
        f.write(f"| 4 | 重複建檔 | {len(picks['dup'])} 家法人各有 2 組客戶代號、不同名稱寫法，統編相同 | 依統編合併為同一家 |\n")
        f.write("| 5 | 單價空值 | 約 4% 單價空白 | 用 未稅金額÷數量 回推 |\n")
        f.write("| 6 | 未稅金額空白 | 1 列 | 用 數量×單價 回推並提示 |\n")
        f.write("| 7 | 統編空白 | 2 列 | 列為待處理，不硬合併 |\n")
        f.write("| 8 | 缺單位成本 | 1 列 | 列為待處理，不補零 |\n")
        f.write("| 9 | 數量為 0 且無單價 | 1 列 | 列為待處理 |\n")
        f.write("| 10 | 到期日空白 | 1 列 | 仍計收入，標示無法判斷逾期 |\n")
        f.write("| 11 | 統編前導零 | 4 家統編以 0 開頭 | 當文字，不得掉零 |\n")
        f.write("| 12 | 金額千分位 | 部分金額為 1,234 並以引號包住 | 正確解析 |\n")
        f.write("| 13 | 名稱前後空白、Email 大小寫 | 少數列 | 清洗 |\n")
        f.write("| 14 | 收款日期晚於基準日 | 8 月訂單的收款日在 9 月 | 視為未收 |\n")
        f.write("| 15 | 備註含個資與價格 | 電話、議價單價、匯款帳號 | 備註整欄不進交接包 |\n")
        f.write(f"| 16 | 訂單單號純數字且 0 開頭 | {lead_orders} 張訂單（例：0026050012），其餘為 SO 開頭 | 當文字，不得掉零 |\n")
        others = "、".join(f"{h} {n} 列" for h, n in blank_cols.items() if h not in ("統一編號", "單價", "單位成本", "未稅金額", "帳款到期日", "收款日期", "備註"))
        f.write(f"| 17 | 其他欄位空白 | {others} | 不當機；業務員空白顯示「未填」；名稱空白時由同法人其他列補顯示 |\n")
        f.write("| 18 | 客戶名稱空白但統編有值 | 見上列「客戶名稱」 | 依統編歸戶，名稱取同法人其他列 |\n")
        f.write(f"\n待處理（不納入計算）共 {truth['pending_count']} 列。\n")
    print(f"OK  {a.out}: {len(data)} 列, {len(ents)} 家法人, 基準日 {base_date}")


if __name__ == "__main__":
    main()
