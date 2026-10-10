"""TACT 射出·计量页（注射/保压参数）提取（035_PLAN 新增）。

取值规则（templates/tact.injection_metering.json）：每个字段一个标签锚点，
值 = 标签下方 value_window（dx 0.06 / dy 0.005~0.06）内最近的数值 token。
保压段数由 Pp2 是否有值推断（1 段机 Pp2/Tp1 为空）。返回结构同 keba。
"""
import re

from .common import _anchor_match  # noqa: F401

NUM_RE = re.compile(r"\d+\.?\d*")


def _num(text: str) -> float | None:
    m = NUM_RE.search(text)
    return float(m.group()) if m else None


def extract_injection_tact(toks: list[dict], template: dict) -> dict:
    warnings: list[str] = []
    anchors = template["field_anchors"]
    win = template["value_window"]

    fields: dict[str, float | list | int | None] = {}
    detail = {}
    sources = {}
    for name, spec in anchors.items():
        hits = [t for t in toks if _anchor_match(spec["label"], t["text"])]
        if not hits:
            fields[name] = None
            warnings.append(f"LABEL_MISSING({spec['label']})")
            continue
        lo, hi = spec["range"]
        # 多命中（如「射出」vs「射出·计量」页签）：取邻域内真有可取值的标签
        chosen = None
        for lab in sorted(hits, key=lambda t: t["y"]):
            cands = []
            for t in toks:
                v = _num(t["text"])
                if v is None or not (lo <= v <= hi):
                    continue
                if (abs(t["x"] - lab["x"]) <= win["dx"]
                        and win["dy_lo"] < t["y"] - lab["y"] <= win["dy_hi"]):
                    cands.append((abs(t["x"] - lab["x"]) + abs(t["y"] - lab["y"]), v, t))
            if cands:
                cands.sort()
                chosen = cands[0]
                break
        if chosen:
            fields[name] = chosen[1]
            detail[name] = {"text": chosen[2]["text"], "conf": round(chosen[2]["conf"], 3)}
            sources[name] = {"line_index": next(i for i, token in enumerate(toks) if token is chosen[2]),
                             "text": chosen[2]["text"], "center": [chosen[2]["x"], chosen[2]["y"]]}
            if chosen[2]["conf"] < 0.8:
                warnings.append(f"LOW_CONF({name},{chosen[2]['conf']:.2f})")
        else:
            fields[name] = None
            warnings.append(f"VALUE_MISSING({name})")

    # 结构组装（与真值 schema 对齐）
    out = {
        "fill_velocity_mms": [fields["fill_velocity_v1_mms"],
                              fields["fill_velocity_v2_mms"],
                              fields["fill_velocity_v3_mms"]],
        "fill_stages": 3,
        "switch_position_sv1_mm": fields["switch_position_sv1_mm"],
        "switch_position_sv2_mm": fields["switch_position_sv2_mm"],
        "metering_position_sm_mm": fields["metering_position_sm_mm"],
        "metering_rpm": fields["metering_rpm"],
        "back_pressure_mpa": fields["back_pressure_mpa"],
        "holding_pressure_mpa": ([fields["holding_pressure_p1_mpa"],
                                  fields["holding_pressure_p2_mpa"]]
                                 if fields["holding_pressure_p2_mpa"] is not None
                                 else [fields["holding_pressure_p1_mpa"]]),
        "holding_stages": 2 if fields["holding_pressure_p2_mpa"] is not None else 1,
        "holding_time_s": fields["holding_time_s"],
        "holding_limit_speed_mms": fields["holding_limit_speed_mms"],
        "vp_switch_position_mm": fields["vp_switch_position_mm"],
        "pressure_limit_mpa": fields["pressure_limit_mpa"],
        "injection_time_s": fields["injection_time_s"],
        "cooling_time_s": fields["cooling_time_s"],
        "decompress_velocity_mms": fields["decompress_velocity_mms"],
        "sd_position_mm": fields["sd_position_mm"],
    }
    detail["field_sources"] = {name: [sources[name]] for name in out if name in sources}
    detail["field_sources"].update({
        "fill_velocity_mms": [sources[name] for name in ("fill_velocity_v1_mms", "fill_velocity_v2_mms", "fill_velocity_v3_mms") if name in sources],
        "holding_pressure_mpa": [sources[name] for name in ("holding_pressure_p1_mpa", "holding_pressure_p2_mpa") if name in sources],
    })
    return {"fields": out, "heater_columns": 0, "warnings": warnings, "detail": detail}
