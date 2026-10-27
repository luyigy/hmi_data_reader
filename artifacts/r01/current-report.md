# R01 OCR-only implementation at f0f4b05

This report supersedes the inherited material-blocker conclusion for this attempt. The saved Spec correction was preserved. No local VLM, table fetch, dependency install, new environment, source-repository write, Git mutation or database access was used.

## Implementation

The existing Reader OCR, rectification, routing and R02 registration/lifecycle remain in use. HTTP opts into v2 with `POST /api/v1/recognize?observations_version=v2`; CLI uses `--observations-version v2 --original-image <original>`. Defaults and historical page extraction remain v1. The new modules own only pure original-screen facts, field definitions and offline integrity checks.

The frozen DEMAG holding definition declares 27 original-screen fields, including actual values, reverse-order stage rows, dark residues, status displays and checkbox controls. Full-screen OCR is supplemented by real cell OCR where a value was missed or a sign may have been clipped. OCR boxes are projected through the actual rectification transform to original-image percentages. Original upload bytes and rectifier input bytes have separate hashes. Template units remain separate from original units.

The package contains the complete definition, v2 JSON Schema, fixed version/hash, implementation hashes, pinned legacy-package hash and sample provenance. It uses the existing package GET/export entry. Version 0.3.0 is explicitly requested and does not become the active v1 template. Missing frozen files and component mismatches fail rather than silently regenerating a published version.

The record validator checks required provenance, package/recognizer identity, field identity and coverage, finite values, coordinates and source dimensions. Manual records have actor/time/revision and an optional separate image reference. They cannot invent recognition provenance, confidence or boxes. Model's installed Python environment actually imported the package schema and constructed/validated offline form fields with network access trapped; it also validated the live Reader record. This is package interoperability evidence, not a claim that Model's application has accepted the new package or implemented raw_page.v2 persistence.

## Actual verification

| Command or surface | Result | Evidence |
| --- | --- | --- |
| `/data1/code/hmi_data_reader/.venv/bin/python -m pytest -q tests/test_hmi_protocol_library_r01.py` | 11 passed | current-final-ticket-behavior.log |
| Real original image, CPU PaddleOCR, multipart ASGI HTTP recognition and actual CLI subprocess | Both returned the same fixed page and expected physical values | current-live-http.json, current-live-script.json |
| Existing package HTTP GET, closed client/new client GET and actual export CLI | Identical frozen package; OCR was forbidden | current-package-get-reopen.json |
| Model existing interpreter, offline schema/form import and live-record validation | Passed, no DB and no Model source writes | current-model-offline-import.json, current-model-live-schema.txt |
| Pinned v1 package replay with Path reads and socket connections trapped | Exact old output hash `eddc3f3f5efa4b466ad7432d1850e8054612d5eda7a8a65e5740100c1b3d1750` | Required behavior entry |
| `PYTHONPATH="$PWD/scripts:$PWD" /data1/code/hmi_data_reader/.venv/bin/python -m pytest -q tests/test_coordinate_projection.py tests/test_demag_stage_enabled.py tests/test_demag_injection.py tests/test_r02_extractor_registry.py tests/test_r02_template_lifecycle.py tests/test_demag_page_contract_baseline.py tests/test_contract.py tests/test_page_template_admin.py` | 110 passed, 22 subtests passed, 2 skipped | current-final-regression-corrected.log |
| `git diff --check` | Passed | Final shell check |
| GitNexus detect_changes all and compare master | CRITICAL shared geometry/HTTP/script flows; expected tracked scope | current-gitnexus-scope.json |

The initial expanded regression invocation lacked this repository's scripts import path and stopped at collection. The corrected command above uses only this repository on PYTHONPATH. The two skips concern old generated rank01 and holding calibration directories that are not mounted; they are not counted as passes. The required entry instead ran the actual available representative image.

## Coverage and truth limits

Observed coverage is partial, with 27 declared fields and 17 known readings. Five checkbox controls remain explicitly unsupported. Unverified status displays remain uncertain, including the OCR candidate `0.52` whose original image shows `-0.52`. Controller family and interface generation remain unknown. No controller is inferred from the brand or filename.

The existing human-reviewed truth covers eight stage values. The complete numeric sample transcription adds an explicitly labelled developer visual audit, not an independent commercial-model or human ruling. The original SHA is `186a514d33458a612eee4479082a2f731cbabf93168f39d8119f11ced5931676`. The third pressure zero remains known while its enabled state remains unknown because the dated recorded rulings conflict. Dark fourth pressure/velocity and third duration zero residues are retained with real source boxes and disabled states. No ambiguous value is advertised as eligible for automatic business writing.

## Joint acceptance boundaries

| ID | Executed here | Still outside this implementation evidence |
| --- | --- | --- |
| A01 | Real Reader HTTP/CLI recognition and frozen export | Model raw save, preview, confirm, independent business GET and browser reopen |
| A04 | Residue, unknown state, actual role, missing and low-confidence observations; distinct source/role/state/reading; original coordinates and template-unit provenance | Model candidate eligibility and business projections |
| A05 | Fixed v1 offline replay without image/template reads or network; offline raw package/form validation | Both Model business-entry replay paths with all related IO trapped |
| A18 | Frozen v1 bytes/semantics and legacy caller regressions | Old Model raw pages, receipts, formal records and retirement of a duplicate editing path |

No UI was changed. No 1440px/390px browser operation, Model business persistence or formal process submission is claimed. Package GET/client reopen is explicitly distinct from Model business/browser reopen. Platform independent acceptance remains pending and cannot be replaced by these author tests or the advisory source review.

## Reuse, review and integration

R02 source commits remain `c5aa25a752d7912f114e30970c55b594346dd0f5` and `982ef2d021286ffff4e2e352af68b2efd6f0bf77`. Inherited reuse.json and source-verification.json retain the per-commit patches and original 14-file equality evidence. The current platform checkpoint is `f0f4b05d6b48fbe9c40bae8b3608aebe730f215a`; final integration SHA is pending the coordinator. No add/commit/merge was performed. Original-repository dirty files were not overwritten or cleaned; this attempt does not claim a new byte inventory of a deployment directory absent from the mounted workspace.

The approved Model source HEAD was checked as `f6a4c64e7dbd94431391e1018a1065df8221c75d`. Tracked Spec/acceptance/raw-capture/package-loader bytes matched fixed Git objects. Its untracked `.agent-platform/` and `contracts/hmi-reader/process-screen/` were excluded. See current-upstream-verification.json.

One read-only helper compared two implementation shapes and recommended explicit v2 boundaries. A second read-only advisory review found mutable fallback, missing provenance validation, unsupported-response shape and manual-image-reference defects. Those were fixed and regression checks added. No helper wrote files. A full diverse-model arena was not run; this was the project's lean, sole-writer implementation plus read-only review. Platform acceptance remains separate.

Model the Domain determined the definition/observation split. Prove It Works and Test Behavior, Not Implementation determined real OCR/HTTP/CLI, offline rejection, package GET and fixed legacy-hash checks. File hashes, versions and the latest receipt are in current-read-versions.json, current-source-hashes.json and current-receipt.json.
