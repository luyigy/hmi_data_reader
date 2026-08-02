"""热流道温控箱数码管面板提取（049 阶段B B4 Z023 新增）。

取值规则（templates/tact.hot_runner_temp.json）：150~500 的 3 位数值 token 按 y
聚两行（上=PV 实时不入、下=SV 设定；斜拍使行距窄至 0.017，gap 取 0.015 防并行；单行回退 mid_y 拆分），SV token 按 x 分配到 6 通道槽。
最优化槽距步长拟合（min quantization error search），最左 token 锚 c1。
'2310'->'c310' 误识取后 3 位，'3100' (缺少小数点) 除以 10。
龙昌兴与 YUDO CW301 面板同构。返回结构同 tact_injection。
"""
import re

NUM = re.compile(r"\d{3}(?:\.\d)?")

DISCARD_KEYWORDS = (
    "CW", "HOT", "RUNNER", "@", "E-M", "SE", "CE", "AUTO",
    "MANU", "SOFT", "BEFORE", "REMOVING", "MODULE"
)


def _sv_value(text: str) -> float | None:
    """提取 SV 数值：'c310'->310、'2310'->310（c->2 误识）、'300.0'->300、'3100'->310。"""
    t = text.strip()
    if any(k in t.upper() for k in DISCARD_KEYWORDS):
        return None
    if t.startswith("2") and len(t) >= 4 and t[1] == "3":
        t = t[1:]  # '2310'->'310'
    m = NUM.search(t)
    if not m:
        return None
    v = float(m.group())
    if 1500 <= v <= 5000 and v % 10 == 0:
        v = v / 10.0
    return v


def extract_hot_runner_tact(toks: list[dict], template: dict) -> dict:
    warnings: list[str] = []
    lo, hi = template["sv_range"]
    n_ch = template["channels"]
    detail: dict = {}

    # 3 位数值 token 聚 y 行（上 PV 下 SV，排除面板底部 >0.40 杂项 token）
    cands = []
    for t in toks:
        v = _sv_value(t["text"])
        if v is not None and lo <= v <= hi and t["y"] < 0.40:
            cands.append({"y": t["y"], "x": t["x"], "v": v, "text": t["text"]})
    cands.sort(key=lambda e: e["y"])
    rows = []
    for e in cands:
        if rows and e["y"] - rows[-1][-1]["y"] <= 0.015:
            rows[-1].append(e)
        else:
            rows.append([e])

    # 斜拍或窄行距兜底：若全聚为 1 行且 candidates ≥ 5，按 mid_y 均分为 PV/SV 两行
    if len(rows) == 1 and len(cands) >= 5:
        mid_y = (min(e["y"] for e in cands) + max(e["y"] for e in cands)) / 2
        top = [e for e in cands if e["y"] <= mid_y]
        bot = [e for e in cands if e["y"] > mid_y]
        if top and bot:
            rows = [top, bot]

    detail["value_rows"] = len(rows)
    if len(rows) < 2:
        return {"fields": None, "heater_columns": 0,
                "warnings": warnings + [f"VALUE_ROWS_MISSING({len(rows)})"], "detail": {}}

    # SV 行判别：含有 '(c|2|sv|v)3' 标记的行优先选为 SV 行；否则选最后一行
    sv_row_cands = [r for r in rows if any(re.search(r"(c|2|sv|v)3", e["text"].lower()) for e in r)]
    sv_row = sorted(sv_row_cands[-1], key=lambda e: e["x"]) if sv_row_cands else sorted(rows[-1], key=lambda e: e["x"])

    xs = [e["x"] for e in sv_row]
    # 最优化槽距步长拟合（0.100 - 0.200 区间极小化量化误差）
    best_step = 0.155
    best_err = 999.0
    for s in [i * 0.002 for i in range(50, 100)]:
        err = sum(min(abs((x - xs[0]) - k * s) for k in range(n_ch)) for x in xs)
        if err < best_err:
            best_err = err
            best_step = s
    step = best_step

    sv = [None] * n_ch
    for e in sv_row:
        idx = round((e["x"] - xs[0]) / step)
        if 0 <= idx < n_ch and sv[idx] is None:
            sv[idx] = e["v"]

    # 插补缺失槽位（从所有 cands 候选补近邻槽）
    for idx in range(n_ch):
        if sv[idx] is None:
            target_x = xs[0] + idx * step
            best = None
            best_dist = 999.0
            for e in cands:
                dist = abs(e["x"] - target_x)
                if dist < step * 0.40 and dist < best_dist:
                    best_dist = dist
                    best = e["v"]
            if best is not None:
                sv[idx] = best

    if all(v is None for v in sv):
        warnings.append("SV_ALL_MISSING")

    fields = {"sv_c": sv}
    return {"fields": fields, "heater_columns": 0, "warnings": warnings, "detail": detail}
