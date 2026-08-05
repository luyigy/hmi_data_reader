"""profile 生命周期判定聚焦测试（031 PLAN S01）。

覆盖：unknown->candidate->verified->quarantined 纯函数转换、反馈事件按稳定
issue ID 幂等、连续 2 个不同 issue 字段不符降 quarantined、人工备注/纯 UX
不计数、字段确认重置连续计数、晋级门禁阈值边界（0.95/0.9）、rejection N/A
不晋级、dry-run 不写盘、--apply 原子更新注册表并生成主仓快照候选。
"""
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import profile_lifecycle as lc

REGISTRY = {
    "version": "1.0.0",
    "profiles": [
        {"profile_id": "demag.injection_metering.multi_stage_holding",
         "status": "candidate", "lifecycle_note": "首份真值已建"},
        {"profile_id": "demag.injection_metering.multi_stage_back_pressure",
         "status": "unknown", "lifecycle_note": "语义未确认"},
    ],
}
PID = "demag.injection_metering.multi_stage_holding"


def issue(issue_id: str, kind: str | None = None, profile_id: str = PID) -> dict:
    payload = {"issue_id": issue_id, "profile_id": profile_id}
    if kind:
        payload["kind"] = kind
    return payload


def good_report(**overrides) -> dict:
    report = {
        "mode": "contract",
        "lifecycle_eligible": True,
        "lifecycle_note": "门禁全过",
        "n_negative": 1,
        "metrics": {"numeric_accuracy": 0.95, "error_auto_import_rate": 0.0,
                    "rejection_accuracy": 1.0},
    }
    report.update(overrides)
    return report


class TransitionTest(unittest.TestCase):
    def test_forward_chain_and_quarantine(self):
        self.assertEqual(lc.transition("unknown", "candidate"), "candidate")
        self.assertEqual(lc.transition("candidate", "verified"), "verified")
        for status in ("unknown", "candidate", "verified"):
            self.assertEqual(lc.transition(status, "quarantined"), "quarantined")

    def test_illegal_transitions_raise(self):
        for current, target in (("unknown", "verified"), ("verified", "candidate"),
                                ("quarantined", "verified"), ("candidate", "unknown")):
            with self.assertRaises(lc.LifecycleError):
                lc.transition(current, target)


class FeedbackTest(unittest.TestCase):
    def setUp(self):
        self.state = {"status": "verified", "mismatch_streak": 0,
                      "seen_issue_ids": []}

    def test_two_consecutive_distinct_mismatches_quarantine(self):
        state, outcome = lc.apply_feedback(self.state, issue("i-1", "field_mismatch"))
        self.assertEqual((outcome, state["status"]), ("counted", "verified"))
        state, outcome = lc.apply_feedback(state, issue("i-2", "field_mismatch"))
        self.assertEqual((outcome, state["status"]), ("quarantined", "quarantined"))

    def test_reimport_same_issue_is_idempotent(self):
        state, _ = lc.apply_feedback(self.state, issue("i-1", "field_mismatch"))
        again, outcome = lc.apply_feedback(state, issue("i-1", "field_mismatch"))
        self.assertEqual(outcome, "duplicate")
        self.assertEqual(again["mismatch_streak"], 1)
        self.assertEqual(again["status"], "verified")

    def test_manual_note_and_ux_only_do_not_count(self):
        state, outcome = lc.apply_feedback(self.state, issue("n-1", "manual_note"))
        self.assertEqual((outcome, state["mismatch_streak"]), ("ignored", 0))
        state, outcome = lc.apply_feedback(state, issue("u-1", "ux_only"))
        self.assertEqual((outcome, state["mismatch_streak"]), ("ignored", 0))
        state, _ = lc.apply_feedback(state, issue("i-1", "field_mismatch"))
        self.assertEqual(state["mismatch_streak"], 1)

    def test_field_match_resets_streak(self):
        state, _ = lc.apply_feedback(self.state, issue("i-1", "field_mismatch"))
        state, outcome = lc.apply_feedback(state, issue("m-1", "field_match"))
        self.assertEqual((outcome, state["mismatch_streak"]), ("streak_reset", 0))
        state, outcome = lc.apply_feedback(state, issue("i-2", "field_mismatch"))
        self.assertEqual((outcome, state["status"]), ("counted", "verified"))

    def test_classify_manifest_content(self):
        self.assertEqual(lc.classify_issue({"differences": [{"hmi_field": "x"}]}),
                         "field_mismatch")
        self.assertEqual(lc.classify_issue({"differences": [], "note": "人工备注"}),
                         "manual_note")
        self.assertEqual(lc.classify_issue({"differences": [], "note": ""}),
                         "ux_only")


class PromotionTest(unittest.TestCase):
    def test_threshold_boundaries(self):
        eligible, reasons = lc.evaluate_promotion(
            good_report(), 0.9, hash_verified=True, web_verified=True)
        self.assertTrue(eligible, reasons)
        eligible, reasons = lc.evaluate_promotion(
            good_report(metrics={"numeric_accuracy": 0.9499,
                                 "error_auto_import_rate": 0.0,
                                 "rejection_accuracy": 1.0}),
            0.9, hash_verified=True, web_verified=True)
        self.assertFalse(eligible)
        self.assertTrue(any("numeric_accuracy" in r for r in reasons))
        eligible, reasons = lc.evaluate_promotion(
            good_report(), 0.899, hash_verified=True, web_verified=True)
        self.assertFalse(eligible)
        self.assertTrue(any("confidence" in r for r in reasons))

    def test_rejection_na_not_eligible(self):
        report = good_report(lifecycle_eligible=False,
                             lifecycle_note="rejection N/A",
                             n_negative=0,
                             metrics={"numeric_accuracy": 1.0,
                                      "error_auto_import_rate": 0.0,
                                      "rejection_accuracy": None})
        eligible, reasons = lc.evaluate_promotion(
            report, 0.95, hash_verified=True, web_verified=True)
        self.assertFalse(eligible)
        self.assertTrue(any("N/A" in r for r in reasons))

    def test_legacy_report_and_missing_evidence_rejected(self):
        eligible, reasons = lc.evaluate_promotion(
            good_report(mode="legacy", lifecycle_eligible=False),
            0.95, hash_verified=True, web_verified=True)
        self.assertFalse(eligible)
        self.assertTrue(any("contract" in r for r in reasons))
        eligible, reasons = lc.evaluate_promotion(
            good_report(), 0.95, hash_verified=False, web_verified=False)
        self.assertFalse(eligible)
        self.assertTrue(any("hash" in r for r in reasons))
        self.assertTrue(any("Web" in r for r in reasons))


class CliTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.registry = self.tmp / "profiles.json"
        self.registry.write_text(json.dumps(REGISTRY, ensure_ascii=False),
                                 encoding="utf-8")
        self.state = self.tmp / "state.json"
        self.script = Path(__file__).resolve().parents[1] / "scripts" / "profile_lifecycle.py"

    def run_cli(self, *argv: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, str(self.script), "--registry", str(self.registry),
             "--state", str(self.state),
             "--snapshot-candidate", str(self.tmp / "snapshot_candidate.json"),
             *argv],
            capture_output=True, text=True)

    def test_dry_run_does_not_write_and_apply_is_atomic(self):
        issue_path = self.tmp / "i1.json"
        issue_path.write_text(json.dumps(issue("i-1", "field_mismatch")),
                              encoding="utf-8")
        result = self.run_cli("import-feedback", str(issue_path))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("dry-run", result.stdout)
        self.assertFalse(self.state.exists())
        self.assertEqual(json.loads(self.registry.read_text(encoding="utf-8")),
                         REGISTRY)

        result = self.run_cli("import-feedback", str(issue_path), "--apply")
        self.assertEqual(result.returncode, 0, result.stderr)
        state = json.loads(self.state.read_text(encoding="utf-8"))
        self.assertEqual(state["profiles"][PID]["mismatch_streak"], 1)
        # 注册表原子更新 + 主仓快照候选同步生成（内容与注册表一致）
        updated = json.loads(self.registry.read_text(encoding="utf-8"))
        self.assertEqual(updated["profiles"][0]["status"], "candidate")
        snapshot = json.loads((self.tmp / "snapshot_candidate.json")
                              .read_text(encoding="utf-8"))
        self.assertEqual(snapshot, updated)

    def test_two_issues_quarantine_via_cli_and_idempotent_reimport(self):
        paths = []
        for name in ("i-1", "i-2"):
            p = self.tmp / f"{name}.json"
            p.write_text(json.dumps(issue(name, "field_mismatch")), encoding="utf-8")
            paths.append(str(p))
        result = self.run_cli("import-feedback", *paths, "--apply")
        self.assertEqual(result.returncode, 0, result.stderr)
        updated = json.loads(self.registry.read_text(encoding="utf-8"))
        holding = next(p for p in updated["profiles"] if p["profile_id"] == PID)
        self.assertEqual(holding["status"], "quarantined")
        # 重复导入同一 issue：幂等，不重复计数、不再变化
        result = self.run_cli("import-feedback", paths[0], "--apply")
        self.assertIn("duplicate", result.stdout)
        state = json.loads(self.state.read_text(encoding="utf-8"))
        self.assertEqual(state["profiles"][PID]["mismatch_streak"], 2)

    def test_promote_blocked_then_allowed(self):
        report_path = self.tmp / "report.json"
        report_path.write_text(json.dumps(good_report()), encoding="utf-8")
        blocked = self.run_cli("promote", PID, "--report", str(report_path),
                               "--confidence", "0.95", "--web-verified")
        self.assertEqual(blocked.returncode, 1)
        self.assertIn("hash", blocked.stdout)
        ok = self.run_cli("promote", PID, "--report", str(report_path),
                          "--confidence", "0.95", "--hash-verified",
                          "--web-verified", "--apply")
        self.assertEqual(ok.returncode, 0, ok.stderr)
        updated = json.loads(self.registry.read_text(encoding="utf-8"))
        holding = next(p for p in updated["profiles"] if p["profile_id"] == PID)
        self.assertEqual(holding["status"], "verified")

    def test_promote_unknown_profile_fails(self):
        report_path = self.tmp / "report.json"
        report_path.write_text(json.dumps(good_report()), encoding="utf-8")
        result = self.run_cli("promote", "demag.injection_metering.multi_stage_back_pressure",
                              "--report", str(report_path), "--confidence", "0.95",
                              "--hash-verified", "--web-verified")
        self.assertEqual(result.returncode, 1)
        self.assertIn("非法状态转换", result.stdout)


if __name__ == "__main__":
    unittest.main()
