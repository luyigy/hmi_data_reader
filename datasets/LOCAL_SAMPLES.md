# Local image samples

Bulk photographs in `datasets/` and `ground_truth/` are local test and calibration data. Keep their JSON/YAML labels, hashes, manifests and documentation in Git. Original photographs, generated images, model binaries, caches, task-run metadata and raw logs stay outside Git tracking.

The compact, hash-pinned `datasets/b_and_r_stability/live_20261028_v15.jpg` is an explicit regression fixture and remains versioned. Add another exception only when it is deliberately selected as a small reproducible fixture.

The 2026-10-29 cleanup removes tracking only. Every original file remains at its existing path. `local-only-assets.manifest.json` records each removed path, size and SHA-256. A verified local archive is at `output/local-only-assets-20261029.tar`; it is ignored and is not an uploaded or off-machine backup. Copy the archive separately when running photo acceptance on another machine, verify its recorded hash, then restore into the repository without overwriting newer local material. Older versions also remain in Git history.

A fresh checkout does not contain the bulk originals. Restore the required samples before running tests that need them; a passing source-only check does not replace real-photo acceptance. Raw evidence logs and generated `artifacts/**/code.diff` remain available locally; committed reports and structured results record the acceptance outcome.

This cleanup does not shrink existing remote history. Historical `output/` images and old `docs/` photo sets still occupy repository storage. Removing those historical objects requires a separate coordinated history migration; this change does not rewrite commits or force-push.
