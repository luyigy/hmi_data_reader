"""热流道温控箱数码管面板提取（049 阶段B B4 Z023 新增）。

取值规则（templates/tact.hot_runner_temp.json）：150~500 的 3 位数值 token 按 y
聚两行（上=PV 实时不入、下=SV 设定；斜拍使行距窄至 0.017，gap 取 0.015 防并行；
单行回退 mid_y 拆分）。'2310'->'c310' 误识取后 3 位，'3100' (缺少小数点) 除以 10。
龙昌兴与 YUDO CW301 面板同构。返回结构同 tact_injection。

2026-08-08 多排扩展：12 通道等双排面板（每排 6 通道，上排 1~6、下排 7~12）。
SV 行判定：优先取含 c/SV 前缀标记 token 的行；标记不全时按位置兜底
（偶数行取每排下行 rows[1::2]）。token y 上限由模板 token_y_max 控制。

2026-08-13（042 S03）：输出字段名由 legacy sv_c 对齐契约目录字段
hot_runner_sv_c（字段目录 v2.7.0 已登记，web_target=hot_runner_zone_temperature_set；
field_meta 由此生效，legacy ground_truth/hr_z023 真值不受契约比对约束）。

2026-08-14（057 S01）：detail 追加 hot_runner_channel_observations——与
hot_runner_sv_c 逐位对齐的逐槽位观察（契约 2.8.0 additive 顶层可选键，由
service 校验后透出）。

2026-08-14（057 S02）：动态槽位提取。槽位数量不再由模板 channels 决定
（模板保留为已见布局提示），改从面板可见结构推导：

1. 槽位建立与 SV 取值分离。每排先由“重复单元锚点”（龙昌兴每通道一组
   SOFT/AUTO/MANU/SET/MODE 按钮标签；YUDO CW301 每单元 YUDO/CW301/PV/SV/OUT
   标签）聚出物理通道列，再把 SV token 按 x 归入最近槽位；无锚点排回退为
   纯值网格（值列 + 单倍槽距空洞插槽）。面板右缘仅在传入矫正图且探针确认
   暗显示窗时最多追加 1 个槽位（斜拍右缘通道按钮 OCR 全丢的既有真图情形），
   无图/亮区不追加，不凭空发明超出画面证据的槽位；不做左缘外推（左插槽会
   平移全部 position，等于伪造全局编号）。
2. 黑屏保留槽位与状态（契约 2.8.0）：槽位无 SV 值时，传入矫正图则探测该
   槽位显示区——暗=blackout（单元在、显示确认黑），亮=unreadable（显示
   亮但 OCR 未读出）；无图一律 unreadable，不冒充已确认黑屏。
3. 只看到部分面板时不伪造全局通道号：position 始终是图内物理顺序 1..N；
   通道标签（面板印刷数字）可读时挂到 label，冲突/不可读为 null，不从
   position 推断标签。
4. 旋转容错：值行 1D 聚行退化（大量单行）时做确定性的 y=kx+b 斜率搜索，
   在去旋转坐标系重聚行（YUDO 斜拍真图同一视觉行 y 漂移 >0.07 的错位根因）。
5. 单次识别 1–100 槽位；超过 100 判定为版面结构不可信，安全拒识
   （CHANNEL_LIMIT_EXCEEDED），不截断、不冒充。
"""
import re

import cv2
import numpy as np

NUM = re.compile(r"\d{3}(?:\.\d)?")
SV_PREFIX_MISREAD = re.compile(r"2(\d{3})$")  # 'c190' 误识为 '2190'（c->2）
CHANNEL_LABEL = re.compile(r"\d{1,3}$")  # 面板印刷通道号（1-100）

DISCARD_KEYWORDS = (
    "CW", "HOT", "RUNNER", "@", "E-M", "SE", "CE", "AUTO",
    "MANU", "SOFT", "BEFORE", "REMOVING", "MODULE"
)

# 每通道重复单元锚点标签：龙昌兴按钮组 + YUDO CW301 单元标签
UNIT_ANCHOR_LABELS = ("龙昌兴", "SOFT", "AUTO", "MANU", "SET", "MODE",
                      "YUDO", "CW301", "PV", "SV", "OUT")

ROW_GAP = 0.015          # 值行 1D 聚行间隔（斜拍窄行距 0.017 防并行）
SLOT_GAP_FALLBACK = 0.155  # 无相邻间隔可估时的槽距兜底（既有 6 通道布局实测）
SLOPE_MAX = 0.6          # 去旋转斜率上限（超过视为结构不可信，不纠）
EDGE_EXTRAPOLATE_MAX = 1  # 每侧边缘最多外推槽位数（需任意 token 覆盖证据）
HOT_RUNNER_CHANNEL_LIMIT = 100  # 契约 2.8.0 单次识别槽位上限


def _sv_value(text: str) -> float | None:
    """提取 SV 数值：'c190'->190、'2190'->190（c->2 误识）、'300.0'->300、'3100'->310。"""
    t = text.strip()
    if any(k in t.upper() for k in DISCARD_KEYWORDS):
        return None
    prefix_misread = SV_PREFIX_MISREAD.fullmatch(t)
    if prefix_misread and 150 <= int(prefix_misread.group(1)) <= 500:
        t = prefix_misread.group(1)  # '2190'->'190'、'2310'->'310'
    m = NUM.search(t)
    if not m:
        return None
    v = float(m.group())
    if 1500 <= v <= 5000 and v % 10 == 0:
        v = v / 10.0
    return v


def _is_sv_token(text: str) -> bool:
    """SV 行标记：字母前缀（'c250'、'SV255.0'、's255.0'、'W2550'——PV 为纯数字），
    或 'c3xx'->'23xx' 误识。仅用于已在取值候选内的 token（面板文字已被值过滤排除）。"""
    t = text.strip()
    if not t:
        return False
    prefix_misread = SV_PREFIX_MISREAD.fullmatch(t)
    return t[0].isalpha() or bool(
        prefix_misread and 150 <= int(prefix_misread.group(1)) <= 500)


def _levenshtein_le1(a: str, b: str) -> bool:
    """编辑距离 ≤1（仅用于 ≥4 字母锚点标签的 OCR 错字容错，如 SOPT->SOFT）。"""
    if abs(len(a) - len(b)) > 1:
        return False
    if a == b:
        return True
    if len(a) == len(b):
        return sum(x != y for x, y in zip(a, b)) == 1
    if len(a) > len(b):
        a, b = b, a
    i = j = skips = 0
    while i < len(a) and j < len(b):
        if a[i] == b[j]:
            i += 1
            j += 1
        else:
            skips += 1
            if skips > 1:
                return False
            j += 1
    return True


def _anchor_label(text: str) -> str | None:
    """token 文本归一到单元锚点标签；非锚点返回 None。

    精确/包含匹配优先（'CW30'->CW301、'SOFTAUTO'->SOFT），≥4 字母标签允许
    编辑距离 1 的错字（'MCDE'->MODE）；2 字母标签（PV/SV）只接受精确匹配，
    避免互相误判。
    """
    t = text.strip().upper()
    if not t or len(t) > 8:
        return None
    if any(k in t for k in ("CAUTION", "ERROR")):
        return None  # 面板警示语（含 OUT 子串）不是单元锚点
    for label in UNIT_ANCHOR_LABELS:
        if t == label:
            return label
    for label in UNIT_ANCHOR_LABELS:
        if len(t) >= 3 and (t in label or label in t):
            return label
    for label in UNIT_ANCHOR_LABELS:
        if len(label) >= 4 and _levenshtein_le1(t, label):
            return label
    return None


def _cluster_centers(xs: list[float], gap: float) -> list[float]:
    """1D 坐标聚类（间隔 > gap 开新簇），返回簇中心。"""
    clusters: list[list[float]] = []
    for x in sorted(xs):
        if clusters and x - clusters[-1][-1] <= gap:
            clusters[-1].append(x)
        else:
            clusters.append([x])
    return [sum(c) / len(c) for c in clusters]


def _cluster_rows(cands: list[dict], key: str = "y", gap: float = ROW_GAP) -> list[list[dict]]:
    """值候选按 y（或去旋转 y'）聚行。"""
    rows: list[list[dict]] = []
    for e in sorted(cands, key=lambda e: e[key]):
        if rows and e[key] - rows[-1][-1][key] <= gap:
            rows[-1].append(e)
        else:
            rows.append([e])
    return rows


def _estimate_slope(cands: list[dict]) -> float:
    """确定性斜率搜索：枚举 |dx|>=0.08 的候选对斜率（|s|<=SLOPE_MAX，0.01 分桶），
    在去旋转坐标重聚行，以（多 token 行数最多、行内 y' 离散最小）选优；斜率 0
    参评，正面板自然保持 0。"""
    if len(cands) < 4:
        return 0.0

    def score(slope: float) -> tuple[int, int, float]:
        ys = [e["y"] - slope * e["x"] for e in cands]
        rows: list[list[float]] = []
        for y in sorted(ys):
            if rows and y - rows[-1][-1] <= ROW_GAP:
                rows[-1].append(y)
            else:
                rows.append([y])
        multi = sum(1 for r in rows if len(r) >= 2)
        in_multi = sum(len(r) for r in rows if len(r) >= 2)
        spread = sum(r[-1] - r[0] for r in rows)
        # 主判据是多 token 行覆盖的 token 数：错误斜率的混行别名（PV 下一列
        # 撞上 SV 上一列）覆盖的 token 必然少于真实行结构
        return (in_multi, multi, -spread)

    buckets: dict[float, list[float]] = {}
    pts = sorted((e["x"], e["y"]) for e in cands)
    for i in range(len(pts)):
        for j in range(i + 1, len(pts)):
            dx = pts[j][0] - pts[i][0]
            if dx < 0.08:
                continue
            s = (pts[j][1] - pts[i][1]) / dx
            if abs(s) <= SLOPE_MAX:
                buckets.setdefault(round(s, 2), []).append(s)
    candidates = [0.0] + [sum(v) / len(v) for v in buckets.values()]
    # 同分时取 |slope| 最小者（最小纠偏原则，正面板保持 0）
    best = max(candidates, key=lambda s: (*score(s), -abs(s)))
    # 非零斜率必须严格优于 0（多 token 行更多或同行数下行内更紧致）才采用
    if best != 0.0 and score(best) > score(0.0):
        return best
    return 0.0


def _estimate_step(value_xs: list[float], anchor_xs: list[float]) -> float:
    """槽距估计：值列与锚点列相邻间隔的中位数（分网格各自取差，避免 δ 偏移污染）。"""
    diffs: list[float] = []
    for xs in (sorted(value_xs), sorted(anchor_xs)):
        diffs.extend(b - a for a, b in zip(xs, xs[1:]) if 0.004 <= b - a <= 0.35)
    if not diffs:
        return SLOT_GAP_FALLBACK
    diffs.sort()
    return diffs[len(diffs) // 2]


def _probe_state(image: np.ndarray | None, x: float, y: float,
                 half_w: float, half_h: float) -> str:
    """槽位显示区探测（契约 2.8.0 黑屏语义）：暗 -> blackout（单元在、显示确认黑）；
    亮 -> unreadable（显示亮但 OCR 未读出）；无图/探针出界 -> unreadable。"""
    if image is None:
        return "unreadable"
    h, w = image.shape[:2]
    x0, x1 = int((x - half_w) * w), int((x + half_w) * w)
    y0, y1 = int((y - half_h) * h), int((y + half_h) * h)
    if x1 <= 0 or y1 <= 0 or x0 >= w or y0 >= h:
        return "unreadable"
    crop = image[max(y0, 0):max(y1, 1), max(x0, 0):max(x1, 1)]
    if crop.size == 0:
        return "unreadable"
    hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
    # 阈值 0.08：真图标定黑窗亮像素比 0.000-0.034，亮数码管 0.29-0.62
    lit = ((hsv[:, :, 1] > 50) & (hsv[:, :, 2] > 80)).mean()
    return "unreadable" if lit > 0.08 else "blackout"


def _dynamic_row_slots(row: list[dict], row_anchors: dict[str, list[float]],
                       image: np.ndarray | None,
                       slope: float, sv_y: float) -> list[dict]:
    """单排动态槽位：先建槽位（锚点列 ∪ 值列 ∪ 空洞插槽 ∪ 边缘外推），再取值。

    row: 本排 SV 值 token；row_anchors: 本排锚点 {标签: [x]}；slope/sv_y: 去
    旋转斜率与本排 SV 行 y'（探针定位显示区用）。边缘外推只在传入图像且探针
    确认暗显示窗（blackout）时建立——亮区/无图一律不外推，不凭空发明槽位。
    返回 [{x, sv, label, state}]，槽位顺序=图内物理顺序。
    """
    value_xs = sorted(e["x"] for e in row)
    best_label = ""
    best_xs: list[float] = []
    for label, xs in row_anchors.items():
        if len(xs) > len(best_xs):
            best_label, best_xs = label, xs
    step = _estimate_step(value_xs, best_xs)
    half_step = step * 0.5

    value_cols = _cluster_centers(value_xs, half_step)
    anchor_cols = _cluster_centers(best_xs, half_step)
    # 锚点列与值列的系统偏移 δ（按钮标签中心相对数码管中心的固定偏移）
    deltas = []
    for a in anchor_cols:
        near = [v for v in value_cols if abs(v - a) <= half_step]
        if near:
            deltas.append(a - min(near, key=lambda v: abs(v - a)))
    delta = sorted(deltas)[len(deltas) // 2] if deltas else 0.0

    # 槽位列 = 值列 ∪ 锚点列（δ 校正后）；重叠视为同一槽
    cols: list[dict] = [{"x": v, "sv": None} for v in value_cols]
    for a in anchor_cols:
        ac = a - delta
        near = [c for c in cols if abs(c["x"] - ac) <= half_step]
        if not near:
            cols.append({"x": ac, "sv": None})
    cols.sort(key=lambda c: c["x"])
    # 单倍槽距空洞插槽（中间黑屏/未读且锚点缺失时仍不左移）
    filled: list[dict] = []
    for i, c in enumerate(cols):
        if i:
            gap = c["x"] - cols[i - 1]["x"]
            if 1.6 * step <= gap <= 2.4 * step:
                filled.append({"x": (cols[i - 1]["x"] + c["x"]) / 2, "sv": None})
        filled.append(c)
    cols = filled
    # 右缘外推：仅图像确认暗显示窗时建立（斜拍右缘通道按钮 OCR 全丢的既有
    # 真图情形）；探针窗必须完整落在画面内（贴边的暗色机身/边框不是显示窗），
    # 无图/亮区不外推。不做左缘外推：左插槽会使全部既有槽位 position +1，
    # 等于伪造全局编号（只看到左半之外的面板时不得平移图内顺序）。
    if image is not None and cols:
        half_w = step * 0.35
        for _ in range(EDGE_EXTRAPOLATE_MAX):
            cand = cols[-1]["x"] + step
            if cand - half_w < 0.005 or cand + half_w > 0.995:
                break
            probe_y = sv_y + slope * cand
            if _probe_state(image, cand, probe_y, half_w, 0.02) == "blackout":
                cols.append({"x": cand, "sv": None})

    # SV 取值：token 归入最近槽（容差 0.45 槽距，先入为主防重复）
    for e in sorted(row, key=lambda e: e["x"]):
        near = [c for c in cols if abs(c["x"] - e["x"]) <= step * 0.45]
        if not near:
            continue
        c = min(near, key=lambda c: abs(c["x"] - e["x"]))
        if c["sv"] is None:
            c["sv"] = e["v"]

    # 槽位状态与显示区探针（无值槽位：暗=blackout / 亮=unreadable / 无图=unreadable）
    slots = []
    for c in cols:
        slot = {"x": c["x"], "sv": c["sv"], "label": None}
        if c["sv"] is None:
            probe_y = sv_y + slope * c["x"]
            slot["state"] = _probe_state(image, c["x"], probe_y,
                                         step * 0.35, 0.02)
        else:
            slot["state"] = "ok"
        slots.append(slot)
    return slots


def _attach_labels(rows_slots: list[list[dict]], toks: list[dict],
                   row_lines: list[float], step_per_row: list[float],
                   slope: float) -> None:
    """面板印刷通道号挂到槽位 label（可读才挂，冲突/不可读保持 None）。

    归属规则：标签属于其下方最近一条“单元锚线”（锚点行均 y'，无锚点排用 SV
    行 y'）之上的排——通道号印刷在单元底部；x 与槽位列对齐（0.45 槽距容差），
    同槽多个不一致候选不猜，保持 None。
    """
    for t in toks:
        text = t["text"].strip()
        if not CHANNEL_LABEL.fullmatch(text):
            continue
        if len(text) > 1 and text.startswith("0"):
            continue  # 面板通道号不带前导零；'06' 等是 E-06 错误码碎片
        number = int(text)
        if not 1 <= number <= HOT_RUNNER_CHANNEL_LIMIT:
            continue
        y_prime = t["y"] - slope * t["x"]
        above = [i for i, line in enumerate(row_lines)
                 if line <= y_prime + 0.02 and y_prime - line <= 0.45]
        if not above:
            continue
        r = max(above, key=lambda i: row_lines[i])
        cand = [s for s in rows_slots[r]
                if abs(s["x"] - t["x"]) <= step_per_row[r] * 0.3]
        if not cand:
            continue
        slot = min(cand, key=lambda s: abs(s["x"] - t["x"]))
        if slot["label"] is None and not slot.get("label_conflict"):
            slot["label"] = text
        elif slot["label"] != text:
            slot["label"] = None  # 冲突不猜
            slot["label_conflict"] = True


def extract_hot_runner_tact(toks: list[dict], template: dict,
                            image_path=None) -> dict:
    warnings: list[str] = []
    lo, hi = template["sv_range"]
    y_max = template.get("token_y_max", 0.40)
    detail: dict = {}

    image = None
    if image_path is not None:
        try:
            image = cv2.imread(str(image_path))
        except Exception:  # noqa: BLE001 - 读图失败降级 unreadable，不阻断提取
            image = None

    # 3 位数值 token 聚 y 行（上 PV 下 SV；底部杂项由 token_y_max 排除）
    cands = []
    for t in toks:
        v = _sv_value(t["text"])
        if v is not None and lo <= v <= hi and t["y"] < y_max:
            cands.append({"y": t["y"], "x": t["x"], "v": v, "text": t["text"]})
    rows = _cluster_rows(cands)

    # 旋转容错（057 S02）：1D 聚行退化（≥3 行且过半单行）时斜率搜索去旋转重聚
    slope = 0.0
    if len(rows) >= 3 and sum(1 for r in rows if len(r) == 1) * 2 > len(rows):
        slope = _estimate_slope(cands)
        if slope:
            for e in cands:
                e["y"] = e["y"] - slope * e["x"]
            rows = _cluster_rows(cands)
            detail["rotate_slope"] = round(slope, 3)

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

    # SV 行判别：含 c/SV 前缀标记的行优先；标记覆盖全部模块排则直接采用，
    # 否则按位置兜底——每个模块排上 PV 下 SV（偶数行取 rows[1::2]）
    marked = [r for r in rows if any(_is_sv_token(e["text"]) for e in r)]
    if marked and len(marked) * 2 >= len(rows):
        sv_rows = marked
    elif len(rows) % 2 == 0:
        sv_rows = rows[1::2]
    else:
        sv_rows = marked or rows[-1:]
    sv_rows = sorted(sv_rows, key=lambda r: min(e["y"] for e in r))
    detail["sv_rows"] = len(sv_rows)

    # 单元锚点分配到排：去旋转坐标下取最近 SV 行（单排容差 0.35，多排取行距 0.6 倍）
    anchors = []
    for t in toks:
        label = _anchor_label(t["text"])
        if label is not None:
            anchors.append({"label": label, "x": t["x"],
                            "y": t["y"] - slope * t["x"]})
    sv_ys = [sum(e["y"] for e in r) / len(r) for r in sv_rows]
    if len(sv_ys) >= 2:
        row_gap = min(b - a for a, b in zip(sv_ys, sv_ys[1:]))
        anchor_tol = row_gap * 0.6
    else:
        anchor_tol = 0.35
    row_anchors: list[dict[str, list[float]]] = [dict() for _ in sv_rows]
    row_anchor_ys: list[list[float]] = [[] for _ in sv_rows]
    for a in anchors:
        dists = [abs(a["y"] - y) for y in sv_ys]
        r = min(range(len(sv_ys)), key=lambda i: dists[i])
        if dists[r] <= anchor_tol:
            row_anchors[r].setdefault(a["label"], []).append(a["x"])
            row_anchor_ys[r].append(a["y"])

    # 逐排动态槽位（槽位建立与取值分离；黑屏保留槽位与状态）
    rows_slots: list[list[dict]] = []
    step_per_row: list[float] = []
    for i, row in enumerate(sv_rows):
        slots = _dynamic_row_slots(row, row_anchors[i], image, slope, sv_ys[i])
        rows_slots.append(slots)
        best_xs = max(row_anchors[i].values(), key=len, default=[])
        step_per_row.append(_estimate_step([e["x"] for e in row], best_xs))

    # 通道标签（面板印刷号）挂载：可读才挂，冲突不猜
    row_lines = [sum(ys) / len(ys) if ys else sv_ys[i]
                 for i, ys in enumerate(row_anchor_ys)]
    _attach_labels(rows_slots, toks, row_lines, step_per_row, slope)

    slots_flat = [s for slots in rows_slots for s in slots]
    detail["slots"] = len(slots_flat)
    if not 1 <= len(slots_flat) <= HOT_RUNNER_CHANNEL_LIMIT:
        return {"fields": None, "heater_columns": 0,
                "warnings": warnings + [
                    f"CHANNEL_LIMIT_EXCEEDED({len(slots_flat)})"], "detail": {}}

    sv = [s["sv"] for s in slots_flat]
    if all(v is None for v in sv):
        warnings.append("SV_ALL_MISSING")

    fields = {"hot_runner_sv_c": sv}
    # 契约 2.8.0 additive：逐槽位通道观察，与 hot_runner_sv_c 逐位对齐，
    # 不压缩黑屏/未读槽位；position 为图内物理顺序，不猜全局通道号。
    detail["hot_runner_channel_observations"] = [
        {"position": index, "label": s["label"], "sv_c": s["sv"],
         "state": s["state"], "confidence": None}
        for index, s in enumerate(slots_flat, 1)
    ]
    return {"fields": fields, "heater_columns": 0, "warnings": warnings, "detail": detail}
