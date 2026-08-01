"""039 PLAN S2：最小夜间 runner 与状态模型（仅标准库）。

职责边界（039 §5 S2，不多做）：
- 启动门禁：工作区干净、权威输入已提交、027 §3.2 含 SAFE_REJECT 条款、
  PLAN frontmatter 与最新 HANDOVER 一致。
- 领片：按 027 §4 业务优先级（本文件 QUEUE 为其可执行编码，逐条带出处），
  跳过 checkpoint 中已终态单元，取下一个非终态「家族 × 页面 × 波次」。
- 四态裁决：PASS / SAFE_REJECT / NOT_APPLICABLE / BLOCKED_EXTERNAL，
  阈值运行时取自 scripts/verify_accuracy.py，不另写一份。
- 单写锁：仓库级 flock（.git/nightly_runner.lock，不污染工作区）。
- 双超时：子进程墙钟 60 分钟 + 10 分钟无心跳；心跳文件由切片脚本自写，runner 只读。
- 原子 checkpoint：临时文件 + os.replace；只记执行状态，不复制优先级/阈值。
- 基础设施失败最多重试 2 次，随后 BLOCKED_EXTERNAL 并继续独立单元。
- 日报骨架：render_daily_report() 生成计数与队首，S3 才落盘。

S2 只支持 --dry-run：真实切片派发属 S3+，非 dry-run 模式只做门禁+领片预演，
不写任何业务产物。
"""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import importlib.util
import json
import os
import re
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

# --- 039 §4 夜间执行契约常量（墙钟/心跳/重试） ---
WALL_CLOCK_LIMIT_S = 60 * 60        # 单切片墙钟上限 60 分钟
HEARTBEAT_TIMEOUT_S = 10 * 60       # 10 分钟无心跳视为卡死
INFRA_MAX_RETRIES = 2               # 基础设施失败最多重试 2 次

# 夜间窗口（039 §4，Asia/Shanghai）：23:00 启动，06:30 停领新切片，07:00 强制退出
WINDOW_CLAIM_OPEN_MIN = 23 * 60
WINDOW_CLAIM_CLOSE_MIN = 6 * 60 + 30
WINDOW_HARD_EXIT_MIN = 7 * 60
FIRST_NIGHT_QUOTA = 3               # 首夜最多 3 个切片（039 §4）

LOCK_PATH = REPO_ROOT / ".git" / "nightly_runner.lock"
STATE_PATH = REPO_ROOT / "output" / "nightly_runner_state.json"
MACHINE_LABELS = REPO_ROOT / "ground_truth" / "machine_labels.json"
VERIFY_ACCURACY = REPO_ROOT / "scripts" / "verify_accuracy.py"

TZ_CST = timezone(timedelta(hours=8))  # Asia/Shanghai（039 §4）

TERMINAL_STATES = ("PASS", "SAFE_REJECT", "NOT_APPLICABLE", "BLOCKED_EXTERNAL")
NON_TERMINAL_FIX = "TARGETED_FIX"  # 一轮定向整改（039 §3.2），非终态
EXECUTABLE_ACTIONS = {"start_first_slice", "next_slice", "resume_parent"}

CONTRACT = "docs/workflow/workflow-contract.yaml"
ROADMAP_027 = "docs/027_ROADMAP_20260801_全局路线图与自动接力协议.md"
PLAN_039 = "docs/039_PLAN_20260801_全机台页面夜间自治.md"

# 权威输入：必须已提交且无未提交改动（039 §4「自动化只读取已提交权威内容」）
AUTHORITATIVE_INPUTS = [
    CONTRACT,
    ROADMAP_027,
    PLAN_039,
    "ground_truth/machine_labels.json",
    "scripts/verify_accuracy.py",
]

# 业务队列：027 §4 优先级的可执行编码（每条带出处；执行状态一律在 checkpoint，
# 不在此处记录）。039 §2 第 3–7 波次（储料/冷却等）待 S6 立项后追加；
# 027 §4-C FANUC/DEMAG 温度页提分为用户两次暂缓项，未获 039 授权，不入队。
QUEUE = [
    {"unit_id": "injection_metering/TACT/wave1", "page": "injection_metering",
     "family": "TACT", "wave": 1, "provenance": "035 第一波 Z022（036）"},
    {"unit_id": "injection_metering/DEMAG/wave1", "page": "injection_metering",
     "family": "DEMAG", "wave": 1, "provenance": "035 第二波 Z002（037/038）"},
    {"unit_id": "injection_metering/FANUC/wave1", "page": "injection_metering",
     "family": "FANUC", "wave": 1,
     "provenance": "027 §4-A / 039 §2-1 / 036 后续波次（候选 Z036）"},
    {"unit_id": "injection_metering/TACT/wave2", "page": "injection_metering",
     "family": "TACT", "wave": 2, "provenance": "039 §2 三波规则（同家族另 2 台泛化）"},
    {"unit_id": "injection_metering/FANUC/wave2", "page": "injection_metering",
     "family": "FANUC", "wave": 2, "provenance": "039 §2 三波规则（同家族另 2 台泛化）"},
    {"unit_id": "temperature/B_AND_R/expansion", "page": "temperature",
     "family": "B_AND_R", "wave": 1, "provenance": "027 §4-B / 034 PLAN（Z050/Z053/Z007）"},
    {"unit_id": "temperature/TACT/generalization", "page": "temperature",
     "family": "TACT", "wave": 2, "provenance": "027 §1 挂起残余 / 031–033"},
    {"unit_id": "temperature/FANUC_DEMAG/generalization", "page": "temperature",
     "family": "FANUC_DEMAG", "wave": 2, "provenance": "039 §2-2 泛化缺口"},
]

# S1 对账时已确认的终态种子（仅执行状态，出处可审计）；checkpoint 存在时以 checkpoint 为准
SEEDED_TERMINAL = {
    "injection_metering/TACT/wave1": {
        "status": "PASS",
        "provenance": "036 HANDOVER：numeric 1.0 / error 0.0 / 分类双 1.0（无负样本，PoC 口径）",
    },
    "injection_metering/DEMAG/wave1": {
        "status": "SAFE_REJECT",
        "provenance": "038 HANDOVER：stage 数组整体 null/review，error 0.0，停止段格 CV",
    },
}


# ---------------------------------------------------------------- 基础工具

def load_verify_gates():
    """运行时从已提交的 verify_accuracy.py 读取验收阈值，不复制常量。"""
    spec = importlib.util.spec_from_file_location("verify_accuracy", VERIFY_ACCURACY)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return {
        "numeric": mod.GATE_NUMERIC_ACCURACY,
        "error": mod.GATE_ERROR_AUTO_IMPORT_RATE,
        "tolerance": mod.TOLERANCE,
    }


def machine_count():
    """机台口径：machine_labels.json 的 machines 实际键数（不手填常量）。"""
    data = json.loads(MACHINE_LABELS.read_text(encoding="utf-8"))
    return len(data.get("machines", {}))


def git_head():
    return subprocess.run(
        ["git", "rev-parse", "--short", "HEAD"], cwd=REPO_ROOT,
        capture_output=True, text=True, check=True).stdout.strip()


def sha256_file(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def parse_frontmatter(path):
    """最小 frontmatter 解析：只取顶层 scalar 键（本仓库文档无需嵌套）。"""
    text = Path(path).read_text(encoding="utf-8")
    m = re.match(r"^---\n(.*?)\n---\n", text, re.S)
    if not m:
        return {}
    fields = {}
    for line in m.group(1).splitlines():
        kv = re.match(r"^([A-Za-z_]+):\s*(.*)$", line)
        if kv:
            fields[kv.group(1)] = kv.group(2).strip().strip('"').strip("'")
    return fields


# ---------------------------------------------------------------- 启动门禁

def check_worktree_clean():
    out = subprocess.run(["git", "status", "--porcelain"], cwd=REPO_ROOT,
                         capture_output=True, text=True, check=True).stdout
    dirty = [l for l in out.splitlines() if l.strip()]
    return dirty


def check_authoritative_committed():
    """权威输入均已提交且当前无未提交改动。"""
    dirty = set()
    out = subprocess.run(["git", "status", "--porcelain", "--"] + AUTHORITATIVE_INPUTS,
                         cwd=REPO_ROOT, capture_output=True, text=True, check=True).stdout
    for line in out.splitlines():
        if line.strip():
            dirty.add(line[3:].strip().strip('"'))
    uncommitted = []
    for rel in AUTHORITATIVE_INPUTS:
        r = subprocess.run(["git", "ls-files", "--error-unmatch", "--", rel],
                           cwd=REPO_ROOT, capture_output=True, text=True)
        if r.returncode != 0:
            uncommitted.append(f"{rel}（未跟踪）")
        elif rel in dirty:
            uncommitted.append(f"{rel}（有未提交改动）")
    return uncommitted


def check_safe_reject_clause():
    """027 §3.2 必须含 SAFE_REJECT 自动裁决条款（039 S1 对账结果）。"""
    text = (REPO_ROOT / ROADMAP_027).read_text(encoding="utf-8")
    m = re.search(r"### 3\.2.*?(?=\n### |\n## |\Z)", text, re.S)
    return bool(m and "SAFE_REJECT" in m.group(0))


def latest_handover_for_plan(plan_rel):
    """编号最大的、plan 字段指向 plan_rel 的 HANDOVER。"""
    best, best_no = None, -1
    for p in sorted(REPO_ROOT.glob("docs/*HANDOVER*.md")):
        fm = parse_frontmatter(p)
        if fm.get("plan") == plan_rel:
            no = int(re.match(r"^(\d+)_", p.name).group(1))
            if no > best_no:
                best, best_no = (p, fm), no
    return best


def check_plan_handover_consistency():
    """PLAN 未收口，且最新 HANDOVER 携带可执行 next_action（或计划已完成）。"""
    fm = parse_frontmatter(REPO_ROOT / PLAN_039)
    problems = []
    if fm.get("doc_status") in ("completed", "superseded"):
        problems.append(f"039 doc_status={fm.get('doc_status')}（已收口，不应再领片）")
    latest = latest_handover_for_plan(PLAN_039)
    if not latest:
        problems.append("找不到指向 039 的 HANDOVER")
    else:
        _, hfm = latest
        if hfm.get("plan_progress") != "complete" and hfm.get("next_action") not in EXECUTABLE_ACTIONS:
            problems.append(
                f"最新 HANDOVER {latest[0].name} next_action={hfm.get('next_action')}（不可执行）")
    return problems


def startup_gates():
    """全部启动门禁；返回失败清单（空 = 通过）。任一失败即退出并写报告（039 §4）。"""
    failures = []
    dirty = check_worktree_clean()
    if dirty:
        failures.append(f"工作区不干净（{len(dirty)} 项）：{dirty[:5]}")
    failures += [f"权威输入未提交：{x}" for x in check_authoritative_committed()]
    if not check_safe_reject_clause():
        failures.append("027 §3.2 缺少 SAFE_REJECT 自动裁决条款")
    failures += check_plan_handover_consistency()
    return failures


# ---------------------------------------------------------------- checkpoint

def load_state():
    """读取 checkpoint；不存在时用 S1 对账的终态种子初始化（幂等，不写盘）。"""
    if STATE_PATH.exists():
        return json.loads(STATE_PATH.read_text(encoding="utf-8"))
    return {
        "version": 1,
        "seeded_from": "039 S1 对账（040 HANDOVER）",
        "units": {uid: dict(info) for uid, info in SEEDED_TERMINAL.items()},
        "retries": {},
    }


def write_checkpoint(state, path=STATE_PATH):
    """原子替换：临时文件 + os.replace（039 §4）。只记执行状态。"""
    state["updated_at"] = datetime.now(TZ_CST).isoformat(timespec="seconds")
    state["git_head"] = git_head()
    tmp = Path(str(path) + ".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def select_next_unit(state):
    """027 §4 顺序中第一个非终态单元；全部终态返回 None（幂等退出）。"""
    units = state.get("units", {})
    for entry in QUEUE:
        if units.get(entry["unit_id"], {}).get("status") not in TERMINAL_STATES:
            return entry
    return None


# ---------------------------------------------------------------- 四态裁决

def adjudicate(report, targeted_fix_used=False, gates=None):
    """按 039 §3 裁决一个单元的验收报告。

    返回 (状态, 理由)。状态为四终态之一或 TARGETED_FIX（非终态，最多一轮）。
    无负样本（rejection_accuracy 空分母）只标 PoC，不宣称完整安全验收（039 §3.1）。
    """
    gates = gates or load_verify_gates()
    numeric = report.get("numeric_accuracy")
    error = report.get("error_auto_import_rate")
    rejection = report.get("rejection_accuracy")  # None = 空分母 N/A
    ctrl = report.get("controller_classification_accuracy")
    page = report.get("page_classification_accuracy")

    if error is not None and error > gates["error"]:
        if not targeted_fix_used:
            return NON_TERMINAL_FIX, (
                f"error_auto_import_rate={error} 超门，允许一轮根因明确的定向整改（039 §3.2）")
        return "BLOCKED_EXTERNAL", (
            f"一轮整改后 error_auto_import_rate={error} 仍无法安全归零；"
            "需字段/整页拒识实现，记 BLOCKED_EXTERNAL 并写明恢复条件（039 §3.2）")

    passed = (
        ctrl == 1.0 and page == 1.0
        and numeric is not None and numeric >= gates["numeric"]
        and (error is None or error <= gates["error"])
        and (rejection is None or rejection == 1.0)
    )
    if passed:
        if rejection is None:
            return "PASS", "全门禁通过；无负样本，仅 PoC 口径，不宣称完整安全验收（039 §3.1）"
        return "PASS", "全门禁通过（含 rejection_accuracy=1.0）"
    return "SAFE_REJECT", (
        f"未达 PASS（numeric={numeric}，门 {gates['numeric']}）但 error=0 可安全拒识："
        "保留可靠字段，风险字段或整页置 null/review，如实报告低完整率（039 §3.2）")


def record_infra_failure(state, unit_id):
    """基础设施失败计数；超过 INFRA_MAX_RETRIES 返回 True（应记 BLOCKED_EXTERNAL）。"""
    retries = state.setdefault("retries", {})
    retries[unit_id] = retries.get(unit_id, 0) + 1
    return retries[unit_id] > INFRA_MAX_RETRIES


# ---------------------------------------------------------------- 双超时监控

def run_with_double_timeout(cmd, heartbeat_path, wall_limit=WALL_CLOCK_LIMIT_S,
                            heartbeat_timeout=HEARTBEAT_TIMEOUT_S):
    """子进程墙钟 + 无心跳双门禁（039 §4）。

    心跳文件由被调用切片脚本自己写，runner 只读 mtime。
    返回 (exit_kind, returncode)：exit_kind ∈ ok / wall_timeout / heartbeat_timeout。
    S2 不对真实切片调用本函数；真实派发属 S3+。
    """
    start = time.monotonic()
    proc = subprocess.Popen(cmd, cwd=REPO_ROOT)
    while proc.poll() is None:
        now = time.monotonic()
        if now - start > wall_limit:
            proc.kill()
            return "wall_timeout", proc.wait()
        hb = Path(heartbeat_path)
        hb_mtime = hb.stat().st_mtime if hb.exists() else start + (time.time() - now)
        if time.time() - hb_mtime > heartbeat_timeout:
            proc.kill()
            return "heartbeat_timeout", proc.wait()
        time.sleep(min(5.0, max(0.1, wall_limit / 10.0)))
    return "ok", proc.returncode


# ---------------------------------------------------------------- 单写锁

class RepoLock:
    """仓库级 flock：只允许一个写任务（039 §4）。锁文件在 .git 内，不污染工作区。"""

    def __init__(self, path=LOCK_PATH):
        self.path = path
        self.fd = None

    def acquire(self):
        self.fd = os.open(self.path, os.O_CREAT | os.O_RDWR, 0o644)
        try:
            fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(self.fd)
            self.fd = None
            return False
        return True

    def release(self):
        if self.fd is not None:
            fcntl.flock(self.fd, fcntl.LOCK_UN)
            os.close(self.fd)
            self.fd = None

    def __enter__(self):
        return self.acquire()

    def __exit__(self, *exc):
        self.release()


# ---------------------------------------------------------------- 窗口与信号

def window_phase(now=None):
    """039 §4 窗口判断：claim_open（可领新片）/ grace_no_claim（06:30–07:00
    只收尾不领新片）/ closed（窗口外，幂等退出）。可注入时间便于演练。"""
    now = (now or datetime.now(TZ_CST)).astimezone(TZ_CST)
    t = now.hour * 60 + now.minute
    if t >= WINDOW_CLAIM_OPEN_MIN or t < WINDOW_CLAIM_CLOSE_MIN:
        return "claim_open"
    if t < WINDOW_HARD_EXIT_MIN:
        return "grace_no_claim"
    return "closed"


_STOP_REQUESTED = False


def _on_stop_signal(signo, frame):
    """信号退出：只置标志，主循环在安全点 checkpoint 后退出（039 §4）。"""
    global _STOP_REQUESTED
    _STOP_REQUESTED = True


def install_signal_handlers():
    signal.signal(signal.SIGTERM, _on_stop_signal)
    signal.signal(signal.SIGINT, _on_stop_signal)


def stop_requested():
    return _STOP_REQUESTED


# ---------------------------------------------------------------- 日报骨架

def render_daily_report(state, next_unit, gate_failures, gates):
    """日报骨架（039 §4）：四态计数、门禁、队首、提交哈希。S3 才落盘 docs/。"""
    counts = {s: 0 for s in TERMINAL_STATES}
    for info in state.get("units", {}).values():
        if info.get("status") in counts:
            counts[info["status"]] += 1
    lines = [
        "# 夜间自治日报（骨架，S2 dry-run 不落盘）",
        f"- 日期：{datetime.now(TZ_CST).date().isoformat()}（Asia/Shanghai）",
        f"- git HEAD：{git_head()}",
        f"- 机台口径：machine_labels.json 实际键数 = {machine_count()}",
        f"- 验收阈值（verify_accuracy.py 运行时读取）：numeric>={gates['numeric']}、"
        f"error={gates['error']}、容差 ±{gates['tolerance']}",
        f"- 启动门禁：{'通过' if not gate_failures else '失败：' + '；'.join(gate_failures)}",
        f"- 夜间窗口：{window_phase()}（23:00 领片 / 06:30 停领 / 07:00 强退，Asia/Shanghai）",
        f"- 首夜配额：最多 {FIRST_NIGHT_QUOTA} 个切片（039 §4，日报无异常后次夜放开）",
        f"- 终态计数：{counts}",
        f"- 下一队首：{next_unit['unit_id'] if next_unit else '（空，幂等退出）'}"
        + (f"（{next_unit['provenance']}）" if next_unit else ""),
    ]
    return "\n".join(lines)


# ---------------------------------------------------------------- 入口

def main(argv=None):
    ap = argparse.ArgumentParser(description="039 S2 最小夜间 runner（仅标准库）")
    ap.add_argument("--dry-run", action="store_true",
                    help="只读：门禁 + 领片 + 日报骨架，不写任何业务产物")
    args = ap.parse_args(argv)

    install_signal_handlers()
    gates = load_verify_gates()
    failures = startup_gates()

    lock = RepoLock()
    if not failures:
        if not lock.acquire():
            failures.append("单写锁被占用：另一 runner 实例在跑，安全退出（039 §4）")

    state = load_state()
    next_unit = None if failures else select_next_unit(state)
    report = render_daily_report(state, next_unit, failures, gates)
    print(report)

    if failures:
        lock.release()
        return 1

    if not args.dry_run:
        lock.release()
        print("\n非 dry-run：S2 不实现真实切片派发（属 S3+），未写任何产物。", file=sys.stderr)
        return 3

    # dry-run：显式不落盘、不写 checkpoint，保证业务目录零 diff
    lock.release()
    print("\ndry-run 完成：未写 checkpoint/日报/业务产物。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
