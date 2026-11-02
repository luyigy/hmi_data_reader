"""054 PLAN S01：对 batch_001 新图逐张调用本地 Reader /api/v1/recognize。

- 单并发、只读调用本机 127.0.0.1:8765 服务，不重启、不改服务；
- 原始响应落 output/s054_download/reader/batch_001/<stem>.json；
- 同步生成 verify_accuracy 所需的 <stem>.fields.json
  （controller_family/page_type/status/fields 子集）；
- 已存在结果的图跳过（幂等续跑）。

用法：
    .venv/bin/python scripts/evaluation/recognize_batch.py --batch-id batch_001
"""
from __future__ import annotations

from pathlib import Path as _ToolPath
import sys as _tool_sys
_tool_root = _ToolPath(__file__).resolve().parents[2]
_tool_sys.path.insert(0, str(_tool_root))
_tool_sys.path.insert(0, str(_tool_root / "scripts"))


import argparse
import json
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SERVICE = "http://127.0.0.1:8765/api/v1/recognize"


def recognize(path: Path, url: str = SERVICE) -> dict:
    boundary = "s054boundary"
    body = b"\r\n".join([
        f"--{boundary}".encode(),
        f'Content-Disposition: form-data; name="file"; filename="{path.name}"'.encode(),
        b"Content-Type: application/octet-stream",
        b"",
        path.read_bytes(),
        f"--{boundary}--".encode(),
        b"",
    ])
    req = urllib.request.Request(
        url, data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(req, timeout=180) as resp:
        return json.loads(resp.read())


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--batch-id", default="batch_001", help="兼容旧批次目录")
    ap.add_argument("--input-dir", type=Path, help="待识别图片目录")
    ap.add_argument("--output-dir", type=Path, help="本次结果目录，内含 reader/ 与 extracted/")
    ap.add_argument("--url", default=SERVICE, help="Reader 识别接口地址")
    args = ap.parse_args()
    img_dir = args.input_dir or ROOT / "output/s054_download" / args.batch_id
    if not img_dir.is_dir():
        ap.error(f"图片目录不存在: {img_dir}")
    raw_dir = args.output_dir / "reader" if args.output_dir else ROOT / "output/s054_download/reader" / args.batch_id
    ext_dir = args.output_dir / "extracted" if args.output_dir else ROOT / "output/s054_download/extracted" / args.batch_id
    raw_dir.mkdir(parents=True, exist_ok=True)
    ext_dir.mkdir(parents=True, exist_ok=True)

    images = sorted(p for p in img_dir.iterdir() if p.suffix.lower() in (".jpg", ".jpeg", ".png"))
    print(f"[recognize_batch] {len(images)} images")
    ok = 0
    for img in images:
        raw_path = raw_dir / f"{img.stem}.json"
        if raw_path.exists():
            print(f"  skip {img.name} (exists)")
            ok += 1
            continue
        try:
            result = recognize(img, args.url)
        except Exception as e:  # noqa: BLE001
            print(f"  ERROR {img.name}: {e}", file=sys.stderr)
            continue
        raw_path.write_text(json.dumps(result, ensure_ascii=False, indent=2),
                            encoding="utf-8")
        fields = {
            "controller_family": result.get("controller_family"),
            "page_type": result.get("page_type"),
            "status": result.get("status"),
            "fields": result.get("fields"),
        }
        (ext_dir / f"{img.stem}.fields.json").write_text(
            json.dumps(fields, ensure_ascii=False, indent=2), encoding="utf-8")
        ok += 1
        print(f"  ok {img.name}: family={result.get('controller_family')} "
              f"page={result.get('page_type')} status={result.get('status')} "
              f"profile={result.get('profile_id')}")
    print(f"[recognize_batch] recognized {ok}/{len(images)}")


if __name__ == "__main__":
    main()
