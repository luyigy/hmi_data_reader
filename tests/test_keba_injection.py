import json
from pathlib import Path

from scripts.extract_families.keba_injection import extract_injection_keba


def _token(text, x, y):
    return {"text": text, "x": x, "y": y, "conf": 1.0}


def _white_layout_tokens(*, terminal_pressure=0, terminal_velocity=0):
    return [
        _token("射胶", .06, .10), _token("段数", .77, .12), _token("4", .86, .12),
        _token("终", .47, .17), _token("3rd", .54, .17),
        _token("2nd", .61, .17), _token("1st", .68, .17),
        _token("压力", .30, .22), _token("140", .47, .22),
        _token("160", .54, .22), _token("160", .61, .22), _token("155bar", .68, .22),
        _token("速度", .30, .28), _token("40", .47, .28),
        _token("80", .54, .28), _token("92", .61, .28), _token("50%", .68, .28),
        _token("到", .30, .34), _token("160.00", .47, .34),
        _token("245.00", .54, .34), _token("295.00", .61, .34),
        _token("螺杆位置模式", .16, .50), _token("140.00", .34, .50),
        _token("射胶时间模式", .16, .56), _token("2.1", .35, .56), _token("8.0s", .43, .56),
        _token("保压", .06, .72), _token("段数", .70, .70), _token("2", .78, .70),
        _token("终", .51, .74), _token("1st", .58, .74),
        _token("压力", .33, .80), _token(str(terminal_pressure), .51, .80),
        _token("40bar", .58, .80), _token("速度", .33, .85),
        _token(str(terminal_velocity), .51, .85), _token("8%", .58, .85),
        _token("到", .33, .90), _token("0.0", .51, .90), _token("1.0", .58, .90),
    ]


def _extract(tokens):
    template = json.loads(
        (Path(__file__).parents[1] / "templates/keba.injection_metering.json").read_text()
    )
    return extract_injection_keba(tokens, template)["fields"]


def test_process_expert_white_layout_extracts_effective_holding_stage():
    fields = _extract(_white_layout_tokens())

    assert fields == {
        "injection_pressure_bar": [155, 160, 160, 140],
        "injection_velocity_pct": [50, 92, 80, 40],
        "injection_end_position_mm": [295, 245, 160, 140],
        "injection_stages": 4,
        "injection_time_s": 2.1,
        "holding_switch_mode": "螺杆位置模式",
        "vp_switch_position_mm": 140,
        "holding_pressure_bar": 40,
        "holding_velocity_pct": [8],
        "holding_time_s": 1,
        "stage_holding_pressure_bar": None,
        "stage_holding_time_s": None,
        "holding_stages": 1,
    }


def test_terminal_holding_stage_is_effective_when_pressure_is_nonzero():
    fields = _extract(_white_layout_tokens(terminal_pressure=5))

    assert fields["holding_stages"] == 2
    assert fields["holding_pressure_bar"] is None
    assert fields["stage_holding_pressure_bar"] == [40, 5]
