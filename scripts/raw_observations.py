"""Version-two dispatch without changing historical recognizer snapshots."""

from raw_temperature_time import DEFINITIONS, recover_temperature_time_cells
from raw_temperature_time import select_raw_profile as select_legacy_profile
from raw_temperature_time import observe_temperature_time_page as observe_legacy_page
from raw_metering import PROFILE, ROOT, observe_metering_page
from raw_fanuc_temperature import PROFILE as FANUC_PROFILE, observe_fanuc_temperature
from raw_yizumi import PROFILE as YIZUMI_PROFILE, VERSION as YIZUMI_VERSION, observe_yizumi_page, matches_yizumi_layout
from raw_arburg import PROFILE as SELOGICA_PROFILE, observe_selogica
from raw_demag_configuration import PROFILE as CONFIGURATION_PROFILE, observe_configuration_page
from raw_bole_injection import PROFILE as BOLE_INJECTION, observe_bole_injection
from raw_arburg_decimal import observe_decimal_selogica
from extract_families.arburg_decimal import recover_decimal_cells

VERSIONED_RECOVERY = {(SELOGICA_PROFILE, "1.0.1"): recover_decimal_cells}


class RawPageRejected(ValueError):
    """A matched page whose physical layout cannot safely produce observations."""

    def __init__(self, code, profile_id):
        super().__init__(code)
        self.detail = dict(code=code, profile_id=profile_id,
                           reason="当前照片的射胶/保压版式无法核实，请核对原图或补拍完整屏幕。",
                           action="review_or_recapture_full_screen")


def select_raw_profile(profile_id, lines):
    if profile_id == YIZUMI_PROFILE:
        if not matches_yizumi_layout(lines):
            raise ValueError("RAW_PAGE_LAYOUT_CONFLICT")
        return YIZUMI_PROFILE
    if profile_id in (FANUC_PROFILE, SELOGICA_PROFILE, CONFIGURATION_PROFILE, BOLE_INJECTION):
        return profile_id
    return PROFILE if profile_id == PROFILE else select_legacy_profile(profile_id, lines)


def observe_temperature_time_page(profile_id, lines, meta, image_sha256, rectified_image=None,
                                  package_root=ROOT, package_version="1.0.0"):
    if profile_id == FANUC_PROFILE:
        return observe_fanuc_temperature(lines, meta, image_sha256, package_root, "0.6.0")
    if profile_id == YIZUMI_PROFILE:
        version = package_version if package_version.startswith("1.") else YIZUMI_VERSION
        try:
            return observe_yizumi_page(lines, meta, image_sha256, package_root, version)
        except ValueError as exc:
            if str(exc) != "RAW_PAGE_LAYOUT_CONFLICT":
                raise
            raise RawPageRejected(str(exc), profile_id) from exc
    if profile_id == SELOGICA_PROFILE:
        if package_version == "1.0.1":
            return observe_decimal_selogica(lines, meta, image_sha256, package_root, package_version)
        return observe_selogica(lines, meta, image_sha256, package_root, package_version)
    if profile_id == CONFIGURATION_PROFILE:
        return observe_configuration_page(lines, meta, image_sha256, package_root, package_version)
    if profile_id == BOLE_INJECTION:
        try:
            return observe_bole_injection(lines, meta, image_sha256, package_root)
        except ValueError as exc:
            if str(exc) not in {"BOLE_INJECTION_LAYOUT_UNVERIFIED", "BOLE_INJECTION_LAYOUT_CONFLICT"}:
                raise
            raise RawPageRejected(str(exc), profile_id) from exc
    if profile_id == PROFILE:
        return observe_metering_page(lines, meta, image_sha256, package_root, package_version)
    return observe_legacy_page(profile_id, lines, meta, image_sha256, rectified_image)
