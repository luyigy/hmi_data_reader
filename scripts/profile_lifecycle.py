"""Profile 生命周期判定（031 PLAN S01）：纯函数转换 + 默认 dry-run CLI。

生命周期：unknown -> candidate -> verified -> quarantined（031 PLAN §4.3）。
- nominate：unknown -> candidate（首份契约真值建立后登记，仅预览）；
- promote：candidate -> verified，须同时满足——contract 模式报告
  lifecycle_eligible=true（数值准确率 >=0.95、错误自动导入率 = 0、
  拒识正确率 = 1 且非 N/A、负例在场）、profile 置信度 >=0.9、
  真值与机器生成文件 hash 已核对、Web 实测已通过；
- feedback：连续 2 个不同 issue 的字段不符 -> 降 quarantined 重新禁止应用；
  按稳定 issue ID 幂等（重复导入同一 issue 不计数）；人工备注/纯 UX 事件
  不计数；字段确认无误事件重置连续计数。

无 daemon、无数据库、无队列：状态文件 + 注册表两个 JSON，默认 --dry-run
只打印判定；显式 --apply 才原子更新 profiles.json（临时文件 + os.replace）
并生成主仓快照候选 datasets/lifecycle/profiles_snapshot_candidate.json。

用法：
    .venv/bin/python scripts/profile_lifecycle.py status
    .venv/bin/python scripts/profile_lifecycle.py import-feedback issue1.json [issue2.json ...] [--apply]
    .venv/bin/python scripts/profile_lifecycle.py nominate <profile_id> [--apply]
    .venv/bin/python scripts/profile_lifecycle.py promote <profile_id> \
        --report output/accuracy_report.json --confidence 0.95 \
        --hash-verified --web-verified [--apply]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_REGISTRY = REPO_ROOT / "contracts" / "profiles.json"
DEFAULT_STATE = REPO_ROOT / "datasets" / "lifecycle" / "state.json"
SNAPSHOT_CANDIDATE = REPO_ROOT / "datasets" / "lifecycle" / "profiles_snapshot_candidate.json"

STATUSES = ("unknown", "candidate", "verified", "quarantined")
EVENT_KINDS = ("field_mismatch", "field_match", "manual_note", "ux_only")
QUARANTINE_STREAK = 2
GATE_NUMERIC_ACCURACY = 0.95
GATE_ERROR_AUTO_IMPORT_RATE = 0.0
GATE_VERIFIED_MIN_CONFIDENCE = 0.9

# 允许的前向转换；quarantined 可从任意状态降级进入
_FORWARD = {("unknown", "candidate"), ("candidate", "verified")}


class LifecycleError(Exception):
    """生命周期判定硬失败。"""


def transition(current: str, target: str) -> str:
    """纯函数：校验并返回目标状态；非法转换抛 LifecycleError。"""
    if current not in STATUSES:
        raise LifecycleError(f"非法当前状态 {current!r}")
    if target == current:
        return current
    if target == "quarantined":
        return target
    if (current, target) in _FORWARD:
        return target
    raise LifecycleError(f"非法状态转换 {current} -> {target}")


def classify_issue(issue: dict) -> str:
    """反馈事件归类：显式 kind 优先；否则按 manifest 内容推断。

    字段不符（differences 非空）= field_mismatch；无纠正内容但有文字备注
    = manual_note（人工备注，不计数）；两者皆空 = ux_only（纯 UX，不计数）。
    """
    kind = issue.get("kind")
    if kind in EVENT_KINDS:
        return kind
    differences = issue.get("differences")
    if isinstance(differences, list) and differences:
        return "field_mismatch"
    if isinstance(issue.get("note"), str) and issue["note"].strip():
        return "manual_note"
    return "ux_only"


def apply_feedback(profile_state: dict, issue: dict) -> tuple[dict, str]:
    """纯函数：对单个 profile 状态应用一条反馈事件，返回 (新状态, 结果)。

    幂等：issue_id 已见 -> ("duplicate") 不改变任何计数。
    """
    issue_id = issue.get("issue_id")
    if not issue_id:
        raise LifecycleError(f"反馈事件缺稳定 issue_id: {issue!r}")
    state = {
        "status": profile_state["status"],
        "mismatch_streak": profile_state["mismatch_streak"],
        "seen_issue_ids": list(profile_state["seen_issue_ids"]),
    }
    if issue_id in state["seen_issue_ids"]:
        return state, "duplicate"
    state["seen_issue_ids"].append(issue_id)
    kind = classify_issue(issue)
    if kind == "field_mismatch":
        state["mismatch_streak"] += 1
        if state["mismatch_streak"] >= QUARANTINE_STREAK and state["status"] != "quarantined":
            state["status"] = transition(state["status"], "quarantined")
            return state, "quarantined"
        return state, "counted"
    if kind == "field_match":
        state["mismatch_streak"] = 0
        return state, "streak_reset"
    return state, "ignored"  # manual_note / ux_only 不计数


def evaluate_promotion(report: dict, confidence: float, *,
                       hash_verified: bool, web_verified: bool) -> tuple[bool, list[str]]:
    """纯函数：candidate -> verified 晋级门禁，返回 (是否通过, 未过原因列表)。"""
    reasons = []
    if report.get("mode") != "contract":
        reasons.append(f"报告 mode={report.get('mode')!r}，晋级只接受 contract 模式")
    if report.get("lifecycle_eligible") is not True:
        reasons.append(f"报告 lifecycle_eligible 非 true（{report.get('lifecycle_note')}）")
    metrics = report.get("metrics") or {}
    numeric = metrics.get("numeric_accuracy")
    if not (isinstance(numeric, (int, float)) and numeric >= GATE_NUMERIC_ACCURACY):
        reasons.append(f"numeric_accuracy={numeric} 未达 {GATE_NUMERIC_ACCURACY}")
    error_rate = metrics.get("error_auto_import_rate")
    if error_rate != GATE_ERROR_AUTO_IMPORT_RATE:
        reasons.append(f"error_auto_import_rate={error_rate} 不严格等于 0")
    rejection = metrics.get("rejection_accuracy")
    if rejection is None:
        reasons.append("rejection_accuracy 为 N/A（空分母不得晋级）")
    elif rejection != 1:
        reasons.append(f"rejection_accuracy={rejection} 不严格等于 1")
    if not (isinstance(report.get("n_negative"), int) and report["n_negative"] >= 1):
        reasons.append("缺负例（至少 1 张该拒就拒样本）")
    if not (GATE_VERIFIED_MIN_CONFIDENCE <= confidence <= 1):
        reasons.append(f"profile_confidence={confidence} 未达 {GATE_VERIFIED_MIN_CONFIDENCE}")
    if not hash_verified:
        reasons.append("真值与机器生成文件 hash 未核对（--hash-verified）")
    if not web_verified:
        reasons.append("Web 实测未通过（--web-verified）")
    return (not reasons), reasons


def load_registry(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def load_state(path: Path, registry: dict) -> dict:
    """合并注册表 status 与状态文件的 streak/seen（注册表为 status 权威）。"""
    persisted = {}
    if path.is_file():
        persisted = json.loads(path.read_text(encoding="utf-8")).get("profiles", {})
    profiles = {}
    for entry in registry.get("profiles", []):
        pid = entry["profile_id"]
        saved = persisted.get(pid, {})
        profiles[pid] = {
            "status": entry["status"],
            "mismatch_streak": saved.get("mismatch_streak", 0),
            "seen_issue_ids": list(saved.get("seen_issue_ids", [])),
        }
    return {"profiles": profiles}


def _atomic_write(path: Path, payload: dict) -> None:
    """临时文件 + os.replace 原子写，崩溃不留半写状态。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
        os.replace(tmp, path)
    except BaseException:
        os.unlink(tmp)
        raise


def _sync_registry(registry: dict, state: dict) -> dict:
    """把状态机结论写回注册表副本（status + lifecycle_note 备注）。"""
    updated = dict(registry)
    profiles = []
    for entry in registry.get("profiles", []):
        entry = dict(entry)
        pst = state["profiles"].get(entry["profile_id"])
        if pst and pst["status"] != entry["status"]:
            entry["lifecycle_note"] = (
                f"{entry.get('lifecycle_note', '')} [lifecycle] "
                f"{entry['status']} -> {pst['status']}".strip())
            entry["status"] = pst["status"]
        profiles.append(entry)
    updated["profiles"] = profiles
    return updated


def _persist(args, registry: dict, state: dict, *, dry_run: bool) -> None:
    if dry_run:
        print("[lifecycle] dry-run：未写注册表/状态文件（加 --apply 生效）")
        return
    updated = _sync_registry(registry, state)
    _atomic_write(Path(args.registry), updated)
    _atomic_write(Path(args.state), state)
    # 主仓快照候选：与注册表同内容，供主仓 contracts/hmi-reader/ 同步复核
    snapshot = Path(args.snapshot_candidate)
    _atomic_write(snapshot, updated)
    print(f"[lifecycle] applied：注册表 -> {args.registry}；状态 -> {args.state}；"
          f"主仓快照候选 -> {snapshot}")


def _require_profile(state: dict, profile_id: str) -> dict:
    pst = state["profiles"].get(profile_id)
    if pst is None:
        raise LifecycleError(f"profile_id {profile_id!r} 未在注册表登记")
    return pst


def main() -> None:
    ap = argparse.ArgumentParser(description="Profile 生命周期判定（默认 dry-run）")
    ap.add_argument("--registry", default=str(DEFAULT_REGISTRY))
    ap.add_argument("--state", default=str(DEFAULT_STATE))
    ap.add_argument("--snapshot-candidate", default=str(SNAPSHOT_CANDIDATE),
                    help="--apply 时生成的主仓快照候选路径")
    sub = ap.add_subparsers(dest="action", required=True)

    sub.add_parser("status", help="打印全部 profile 生命周期状态")

    p_fb = sub.add_parser("import-feedback", help="导入反馈 issue（按 issue_id 幂等）")
    p_fb.add_argument("issues", nargs="+", help="反馈 manifest 或最小 issue JSON")
    p_fb.add_argument("--apply", action="store_true", help="原子写注册表/状态（默认 dry-run）")

    p_nm = sub.add_parser("nominate", help="unknown -> candidate（首份契约真值建立）")
    p_nm.add_argument("profile_id")
    p_nm.add_argument("--apply", action="store_true")

    p_pm = sub.add_parser("promote", help="candidate -> verified（机器门禁判定）")
    p_pm.add_argument("profile_id")
    p_pm.add_argument("--report", required=True, help="verify_accuracy contract 报告 JSON")
    p_pm.add_argument("--confidence", type=float, required=True)
    p_pm.add_argument("--hash-verified", action="store_true",
                      help="真值与机器生成文件 hash 已核对（datasets.py check 通过）")
    p_pm.add_argument("--web-verified", action="store_true", help="Web 实测已通过")
    p_pm.add_argument("--apply", action="store_true")

    args = ap.parse_args()
    dry_run = not getattr(args, "apply", False)

    registry = load_registry(Path(args.registry))
    state = load_state(Path(args.state), registry)

    try:
        if args.action == "status":
            for pid, pst in state["profiles"].items():
                print(f"{pid}: {pst['status']}"
                      f"（mismatch_streak={pst['mismatch_streak']}，"
                      f"seen_issues={len(pst['seen_issue_ids'])}）")
            return

        if args.action == "import-feedback":
            for issue_path in args.issues:
                issue = json.loads(Path(issue_path).read_text(encoding="utf-8"))
                pid = issue.get("profile_id")
                pst = _require_profile(state, pid)
                new_pst, outcome = apply_feedback(pst, issue)
                state["profiles"][pid] = new_pst
                print(f"[lifecycle] {pid}: issue {issue.get('issue_id')} -> {outcome}"
                      f"（status={new_pst['status']}，streak={new_pst['mismatch_streak']}）")
            _persist(args, registry, state, dry_run=dry_run)
            return

        if args.action == "nominate":
            pst = _require_profile(state, args.profile_id)
            pst["status"] = transition(pst["status"], "candidate")
            print(f"[lifecycle] {args.profile_id}: -> candidate")
            _persist(args, registry, state, dry_run=dry_run)
            return

        if args.action == "promote":
            pst = _require_profile(state, args.profile_id)
            report = json.loads(Path(args.report).read_text(encoding="utf-8"))
            eligible, reasons = evaluate_promotion(
                report, args.confidence,
                hash_verified=args.hash_verified, web_verified=args.web_verified)
            if not eligible:
                print(f"[lifecycle] {args.profile_id}: 晋级门禁未过，保持 {pst['status']}：")
                for reason in reasons:
                    print(f"  - {reason}")
                sys.exit(1)
            pst["status"] = transition(pst["status"], "verified")
            pst["mismatch_streak"] = 0
            print(f"[lifecycle] {args.profile_id}: candidate -> verified（门禁全过）")
            _persist(args, registry, state, dry_run=dry_run)
            return
    except LifecycleError as exc:
        print(f"[lifecycle] ERROR: {exc}")
        sys.exit(1)


if __name__ == "__main__":
    main()
