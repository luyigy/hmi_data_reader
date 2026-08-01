"""026_PLAN S6：DEMAG 温度页模板校准——12 图 OCR 实测锚点算术平均。

对 output/fanuc_demag_calib/rectified/demag_*.ocr.json（基础+CLAHE 合并）逐图实测：
- 行标签 y 锚点：实际/设定/上偏差/下偏差（OCR 常截字：实际->际、上/下偏差->差X，按 x<0.2 模糊匹配，
  两个"差"行按 y 顺序定上下）；
- 列 x：实际行 5 个数值 token（屏幕序 喷嘴1/区3/区2/区1/料口）；
- 保温值：保温[°C] 标签右下方数值。
跨图算术平均输出模板片段（stdout）。行/列位以逐图实测为准，均值为兜底。

用法：python3 scripts/s8_demag_template_calib.py
"""
import json
import re
from pathlib import Path

RECT = Path("output/fanuc_demag_calib/rectified")
NUM = re.compile(r"^-?\d+(\.\d+)?$")


def load_tokens(stem, suffix):
    p = RECT / f"{stem}.{suffix}"
    return json.loads(p.read_text()).get("lines", []) if p.exists() else []


def norm(lines, W, H):
    return [{"text": l["text"], "conf": float(l["conf"]),
             "x": ((l["bbox"]["x_min"] + l["bbox"]["x_max"]) / 2) / W,
             "y": ((l["bbox"]["y_min"] + l["bbox"]["y_max"]) / 2) / H} for l in lines]


def main():
    stems = sorted(p.name[:-9] for p in RECT.glob("demag_*.ocr.json"))
    assert stems, "无 demag OCR 产物"
    per_image = {}
    for stem in stems:
        rj = json.loads((RECT / f"{stem}.rectify.json").read_text())
        W, H = rj["screen_size"]
        toks = norm(load_tokens(stem, "ocr.json"), W, H)
        keys = {(t["text"], round(t["x"], 2), round(t["y"], 2)) for t in toks}
        for t in norm(load_tokens(stem, "ocr_clahe.json"), W, H):
            if (t["text"], round(t["x"], 2), round(t["y"], 2)) not in keys:
                toks.append(t)

        # 行标签（x<0.2 模糊匹配，截字容忍）
        cur = [t for t in toks if t["x"] < 0.2 and ("实际" in t["text"] or t["text"].strip() == "际")
               and 0.3 < t["y"] < 0.6]
        set_ = [t for t in toks if t["x"] < 0.2 and "设定" in t["text"] and 0.3 < t["y"] < 0.6]
        dev = sorted([t for t in toks if t["x"] < 0.2 and "差" in t["text"] and 0.35 < t["y"] < 0.65],
                     key=lambda t: t["y"])
        rows = {}
        if cur:
            rows["current"] = min(cur, key=lambda t: t["y"])["y"]
        if set_:
            rows["set"] = min(set_, key=lambda t: t["y"])["y"]
        if len(dev) >= 2:
            rows["high"], rows["low"] = dev[0]["y"], dev[1]["y"]

        # 实际行 5 数值列（屏幕序 喷嘴1/区3/区2/区1/料口）
        cols = None
        if "current" in rows:
            band = [t for t in toks
                    if abs(t["y"] - rows["current"]) < 0.02 and NUM.match(t["text"].strip())
                    and 0.08 < t["x"] < 0.9 and float(t["text"]) >= 10]
            band.sort(key=lambda t: t["x"])
            # 同一数值被基础/CLAHE 两路重复检出：x 去重（保高置信），仍多于 5 则逐个删最低置信
            dedup = []
            for t in band:
                if dedup and abs(t["x"] - dedup[-1]["x"]) < 0.025:
                    if t["conf"] > dedup[-1]["conf"]:
                        dedup[-1] = t
                else:
                    dedup.append(t)
            while len(dedup) > 5:
                dedup.remove(min(dedup, key=lambda t: t["conf"]))
            if len(dedup) >= 4:
                cols = [round(t["x"], 4) for t in dedup]

        # 保温值（保温 标签右侧/右下数值，100-300°C）
        hold = None
        hl = [t for t in toks if "保温" in t["text"]]
        if hl:
            hy = hl[0]["y"]
            cand = [t for t in toks if NUM.match(t["text"].strip())
                    and 100 <= float(t["text"]) <= 300 and abs(t["y"] - hy) < 0.06
                    and t["x"] > hl[0]["x"]]
            if cand:
                hold = round(min(cand, key=lambda t: abs(t["y"] - hy))["x"], 4)

        per_image[stem] = {"rows": rows, "cols": cols, "holding_value_x": hold}
        print(f"{stem}: rows={ {k: round(v,4) for k,v in rows.items()} } cols={cols} hold_x={hold}")

    ok = [v for v in per_image.values() if v["cols"] and len(v["cols"]) == 5 and len(v["rows"]) == 4]
    print(f"\n完整实测（5 列齐全）{len(ok)}/{len(per_image)} 图")
    if not ok:
        return
    avg_rows = {k: round(sum(v["rows"][k] for v in ok) / len(ok), 4)
                for k in ("current", "set", "high", "low")}
    avg_cols = [round(sum(v["cols"][i] for v in ok) / len(ok), 4) for i in range(5)]
    print("\n模板片段（均值，兜底用；屏幕序 喷嘴1/区3/区2/区1/料口）:")
    print(json.dumps({"row_anchor_y": avg_rows,
                      "column_x[喷嘴1,区3,区2,区1,料口]": avg_cols},
                     ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
