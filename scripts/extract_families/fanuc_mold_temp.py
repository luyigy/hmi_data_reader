"""发那科 模具温度调节机 提取器（049 阶段B B5 Z036 新增）。

取值规则（templates/fanuc.mold_temp.json）：
找数码管/LCD 中的 SV 设定值 token (0~200°C 数值)，如 40.0。
若数码管关断/黑屏/报错，记 null。

2026-08-13（042 S04）：输出字段由裸 set_temperature_c 对齐契约目录
mold_temperature_set_c（字段目录 v2.7.1 已登记；legacy ground_truth/mt_z036
真值不受契约比对约束）。
"""


def extract_mold_temp_fanuc(toks: list[dict], template: dict) -> dict:
    warnings: list[str] = []
    sv_val = None

    for t in toks:
        text = t["text"].strip()
        if text.replace(".", "", 1).isdigit():
            v = float(text)
            if 10.0 <= v <= 200.0:
                sv_val = v
                break

    fields = {"mold_temperature_set_c": sv_val}
    return {"fields": fields, "heater_columns": 0, "warnings": warnings, "detail": {}}
