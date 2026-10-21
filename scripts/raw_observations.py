"""Version-two dispatch without changing historical recognizer snapshots."""

from raw_temperature_time import DEFINITIONS, recover_temperature_time_cells
from raw_temperature_time import select_raw_profile as select_legacy_profile
from raw_temperature_time import observe_temperature_time_page as observe_legacy_page
from raw_metering import PROFILE, ROOT, observe_metering_page
from raw_fanuc_temperature import PROFILE as FANUC_PROFILE, observe_fanuc_temperature
from raw_demag_configuration import PROFILE as CONFIGURATION_PROFILE, observe_configuration_page
from raw_bole_injection import PROFILE as BOLE_INJECTION, observe_bole_injection


def select_raw_profile(profile_id, lines):
    if profile_id in (FANUC_PROFILE, CONFIGURATION_PROFILE, BOLE_INJECTION):
        return profile_id
    return PROFILE if profile_id == PROFILE else select_legacy_profile(profile_id, lines)


def observe_temperature_time_page(profile_id, lines, meta, image_sha256, rectified_image=None,
                                  package_root=ROOT, package_version="1.0.0"):
    if profile_id == FANUC_PROFILE:
        return observe_fanuc_temperature(lines, meta, image_sha256, package_root, "0.6.0")
    if profile_id == CONFIGURATION_PROFILE:
        return observe_configuration_page(lines, meta, image_sha256, package_root, package_version)
    if profile_id == BOLE_INJECTION:
        return observe_bole_injection(lines, meta, image_sha256, package_root)
    if profile_id == PROFILE:
        return observe_metering_page(lines, meta, image_sha256, package_root, package_version)
    return observe_legacy_page(profile_id, lines, meta, image_sha256, rectified_image)
