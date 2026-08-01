"""026_PLAN S5：FANUC 温度页模板校准——6 图 OCR 实测锚点算术平均。

对 output/fanuc_demag_calib/rectified/fanuc_*.ocr.json（基础路；缺 token 时并入 CLAHE 路）
逐图实测：行标签（现在/输出/上限/设定/下限）y 锚点 + 设定行 9 个数值 token 的列 x 中心
（M1-M4 恒 0.0、N=340、B1-B3=335、H=50，9 值恒在，是最稳的列位依据），
跨图算术平均后输出模板片段 JSON（stdout）。行/列位以逐图实测为准，均值为兜底。

用法：python3 scripts/s7_fanuc_template_calib.py
"""
import json
import re
from pathlib import Path

RECT = Path("output/fanuc_demag_calib/rectified")
ROW_LABELS = ["现在", "输出", "上限", "设定", "下限"]
NUM = re.compile(r"^-?\d+(\.\d+)?$")


def load_tokens(stem: str, suffix: str):
    p = RECT / f"{stem}.{suffix}"
    if not p.exists():
        return []
    d = json.loads(p.read_text())
    return d.get("lines", [])


def norm(lines, W, H):
    out = []
    for l in lines:
        b = l["bbox"]
        out.append({"text": l["text"], "conf": float(l["conf"]),
                    "x": ((b["x_min"] + b["x_max"]) / 2) / W,
                    "y": ((b["y_min"] + b["y_max"]) / 2) / H})
    return out


def main():
    stems = sorted(p.name[:-9] for p in RECT.glob("fanuc_*.ocr.json"))
    assert stems, "无 fanuc OCR 产物"
    per_image = {}
    for stem in stems:
        rj = json.loads((RECT / f"{stem}.rectify.json").read_text())
        W, H = rj["screen_size"] if "screen_size" in rj else (rj["width"], rj["height"])
        toks = norm(load_tokens(stem, "ocr.json"), W, H)
        # 合并 CLAHE 路：补基础路没有的 token（按文本+位置去重）
        base_keys = {(t["text"], round(t["x"], 2), round(t["y"], 2)) for t in toks}
        for t in norm(load_tokens(stem, "ocr_clahe.json"), W, H):
            if (t["text"], round(t["x"], 2), round(t["y"], 2)) not in base_keys:
                toks.append(t)

        rows = {}
        for lab in ROW_LABELS:
            cand = [t for t in toks if t["text"].strip() == lab and t["x"] < 0.25]
            if cand:
                rows[lab] = min(cand, key=lambda t: t["y"])["y"]
        # 输出行 5 个数值列（N/B1/B2/B3/H 恒为 5 个独立 token；现在行数值常粘连不可用）
        out_y = rows.get("输出")
        cols = None
        if out_y is not None:
            band = []
            for t in toks:
                txt = t["text"].strip().replace("-", ".")
                txt = re.sub(r"[^0-9.]", "", txt)
                if abs(t["y"] - out_y) < 0.025 and NUM.match(txt) and 0.25 < t["x"] < 0.7:
                    band.append(t)
            band.sort(key=lambda t: t["x"])
            if len(band) >= 5:
                cols = [round(t["x"], 4) for t in band[-5:]]
        per_image[stem] = {"rows": rows, "out_row_cols[N,B1,B2,B3,H]": cols}
        print(f"{stem}: rows={ {k: round(v,4) for k,v in rows.items()} } cols={cols}")

    ok = [v for v in per_image.values() if v["out_row_cols[N,B1,B2,B3,H]"] and len(v["rows"]) == 5]
    print(f"\n完整实测 {len(ok)}/{len(per_image)} 图")
    if not ok:
        return
    avg_rows = {lab: round(sum(v["rows"][lab] for v in ok) / len(ok), 4) for lab in ROW_LABELS}
    avg_cols = [round(sum(v["out_row_cols[N,B1,B2,B3,H]"][i] for v in ok) / len(ok), 4)
                for i in range(5)]
    print("\n模板片段（均值，兜底用）:")
    print(json.dumps({"row_anchor_y": avg_rows,
                      "barrel_columns[N,B1,B2,B3]": avg_cols[:4],
                      "drop_port_column[H]": avg_cols[4]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
