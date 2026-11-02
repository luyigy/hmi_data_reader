"""Dispatch v2 observations for the registered B&R injection/holding page."""
from extract_families.b_and_r.injection_holding.package import PROFILE, ROOT
from extract_families.b_and_r.injection_holding.extractor import observe_bole_injection


class RawPageRejected(ValueError):
    def __init__(self, code, profile_id):
        super().__init__(code)
        self.detail = dict(code=code, profile_id=profile_id,
                           reason="当前照片的射胶/保压版式无法核实，请核对原图或补拍完整屏幕。",
                           action="review_or_recapture_full_screen")


def select_raw_profile(profile_id, lines):
    if profile_id != PROFILE:
        raise ValueError("RAW_PAGE_UNSUPPORTED")
    return profile_id


def observe_temperature_time_page(profile_id, lines, meta, image_sha256, rectified_image=None,
                                  package_root=ROOT, package_version="1.0.0"):
    select_raw_profile(profile_id, lines)
    if package_version in ("0.6.0", "0.6.1"):
        raise RawPageRejected("RAW_PAGE_VERSION_UNSUPPORTED", profile_id)
    try:
        return observe_bole_injection(lines, meta, image_sha256, package_root)
    except ValueError as exc:
        if str(exc) not in {"BOLE_INJECTION_LAYOUT_UNVERIFIED", "BOLE_INJECTION_LAYOUT_CONFLICT"}:
            raise
        raise RawPageRejected(str(exc), profile_id) from exc
