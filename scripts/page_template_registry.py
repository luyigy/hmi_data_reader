"""Shared page selection for CLI, HTTP and Feishu extraction."""
import json
import re
from pathlib import Path
from classify_ui import find_page
from extract_families.common import _anchor_hits

TEMPLATES_DIR = Path("templates")

def registered_page_templates(family: str, templates_dir: Path,
                              page: str | None = None,
                              lines: list[dict] | None = None,
                              include_disabled: bool = False) -> list[dict]:
    registry = templates_dir.parent / "contracts" / "profiles.json"
    if not registry.is_file():
        return []
    texts = [line["text"].strip() for line in lines] if lines is not None else None
    matches = []
    for profile in json.loads(registry.read_text()).get("profiles", []):
        filename = profile.get("template")
        if not filename:
            continue
        path = templates_dir / filename
        template = json.loads(path.read_text())
        if template.get("profile_id") != profile["profile_id"]:
            raise ValueError(f"Registered template identity mismatch: {path}")
        if not include_disabled and template.get("enabled", True) is not True:
            continue
        if page is not None and template.get("page") != page:
            continue
        if family not in template.get("route_families", [template.get("ui_family")]):
            continue
        if texts is not None:
            anchors = template.get("layout_anchors", [])
            if not anchors or not all(any(re.fullmatch(anchor, text, re.I) for text in texts)
                                      for anchor in anchors):
                continue
        matches.append(template)
    return matches

def route_page(stem: str, lines: list[dict], family: str,
               templates_dir: Path = TEMPLATES_DIR,
               extra_anchor_lines: list[dict] | None = None) -> tuple[str, str]:
    """页面路由：结构锚点优先（该家族温度页模板的 油温列头 + 设定/控制行锚点
    同时在场），其次 classify_ui.find_page，最后文件名兜底。

    find_page 会被页内 '设定°C'/'控制%' 行标签与底部 Tab 干扰（实测 rec12 误判
    settings），所以温度页模板锚点命中时直接判 temperature。

    extra_anchor_lines（042 S04）：模温机旁车等附加 OCR 行，仅参与模板锚点
    文本匹配，不进 find_page 的位置启发（坐标系可能不同）。"""
    disabled = [template for template in registered_page_templates(
        family, templates_dir, lines=lines, include_disabled=True)
        if template.get("enabled", True) is not True]
    if disabled:
        return "unknown", "disabled_template"
    registered = registered_page_templates(family, templates_dir, lines=lines)
    if len(registered) > 1:
        return "unknown", "ambiguous_template_anchors"
    if registered:
        return registered[0]["page"], "template_anchors"
    tpl = load_template(family, "temperature", templates_dir) if family != "unknown" else None
    texts = [l["text"] for l in lines + (extra_anchor_lines or [])]
    if tpl:
        anchors = tpl["row_anchors"]
        # 模板可声明自己的页面检测锚点（TACT 无油温列头）；缺省保持 ZizES 口径
        # 锚点值为字符串或候选列表（KEBA 设定温度/温度设置 双子变体）
        keys = tpl.get("page_detect_anchors", ["oil_header", "set", "control"])
        if all(_anchor_hits(anchors[k], texts) for k in keys):
            return "temperature", "template_anchors"
        # 083 S07：模板可再声明备选锚点组（page_detect_anchor_groups，任一组
        # 全命中即判温度页）——TACT 温度页五段变体的行标签（设定温度/现在温度/
        # 控制输出）可能被 OCR 整列丢失，但落下口列头仍在（落下口仅出现于
        # 温度页，全仓 OCR 语料无注射/其它页命中）。
        for group in tpl.get("page_detect_anchor_groups", []):
            if group and all(_anchor_hits(anchors[k], texts) for k in group):
                return "temperature", "template_anchors"
    if family != "unknown":
        # 非温度页模板锚点路由（049 B2 molding_monitor 等）：全部 page_detect_anchors
        # 在场即判该页（锚点设计成跨页互斥）
        # 042 S04：模温机等独立设备家族没有 temperature 模板——锚点循环移出
        # if tpl 分支，否则设备面板的「温度循环控制机」「冷却」字样会被
        # find_page 误分为注塑机 temperature/storage_cooling 后 NO_TEMPLATE 误拒。
        matches = []
        for tp in sorted(templates_dir.glob(f"{family.lower()}.*.json")):
            page_name = tp.stem.split(".", 1)[1]
            if page_name == "temperature":
                continue
            t2 = json.loads(tp.read_text())
            anchors2 = t2.get("page_detect_anchors")
            if anchors2 and all(_anchor_hits(a, texts) for a in anchors2):
                matches.append(page_name)
        if len(matches) > 1:
            return "unknown", "ambiguous_template_anchors"
        if matches:
            return matches[0], "template_anchors"
    page, _ = find_page(lines)
    if page != "unknown":
        return page, "find_page"
    if "炮筒" in stem:
        return "temperature", "filename_hint"
    return "unknown", "none"


def load_template(family: str, page: str, templates_dir: Path = TEMPLATES_DIR,
                  lines: list[dict] | None = None) -> dict | None:
    registered = registered_page_templates(family, templates_dir, page=page, lines=lines)
    if lines is not None and not registered:
        registered = [template for template in registered_page_templates(
            family, templates_dir, page=page) if not template.get("require_anchor_match")]
    if len(registered) > 1:
        return None
    if registered:
        return registered[0]
    filename = f"{family.lower()}.{page}.json"
    path = templates_dir / filename
    if not path.is_file():
        return None
    return json.loads(path.read_text())


def resolve_page_template(stem: str, lines: list[dict], family: str,
                          templates_dir: Path = TEMPLATES_DIR,
                          extra_anchor_lines: list[dict] | None = None) -> tuple[str, str, dict | None]:
    """Route one image and select its template with the shared legacy page aliases."""
    page, source = route_page(stem, lines, family, templates_dir,
                              extra_anchor_lines=extra_anchor_lines)
    template = load_template(family, page, templates_dir, lines=lines)
    if template is None and source != "ambiguous_template_anchors" and (
                            (family == "DEMAG" and page in ("injection_metering", "monitor_curve"))
                             or (family == "TRD6" and page in ("injection_metering", "settings"))
                             or (family == "ARBURG" and page in ("injection_metering", "monitor_curve", "unknown"))):
        template = load_template(family, "injection_metering", templates_dir, lines=lines)
        if template is not None:
            page = "injection_metering"
    return page, source, template
