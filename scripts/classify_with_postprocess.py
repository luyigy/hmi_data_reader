"""跑 UI 家族分类，使用 B 路径后处理的 brand-fuzzy 结果。

对比 classify_ui_v2_report.json 的召回率。
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, "scripts")
from classify_ui import classify  # noqa: E402

OCR_DIR = Path("output/json")
OUT = Path("output/classify_with_postprocess_report.json")


def main():
    files = sorted(OCR_DIR.glob("v2_*.ocr.json"))
    results = []
    for p in files:
        # 用后处理结果覆盖 OCR 文本（仅 brand 字段层面）
        post = OCR_DIR / (p.stem + ".postprocessed.json")
        if not post.exists():
            continue

        # 跑基础分类
        r = classify(p)
        # 合并：扫描后处理的 fix_log，把 fuzzy brand hit 加到 result 描述
        post_data = json.loads(post.read_text())
        brand_hits = [l for l in post_data["fix_log"] if "brand-fuzzy" in l]
        if brand_hits:
            r["postprocess_brand_fuzzy"] = brand_hits
            # 把 ui_family 改成 fuzzy match 的家族
            for bh in brand_hits:
                # 提取家族名
                if "-> " in bh:
                    family = bh.split("-> ")[1].split(" ")[0]
                    r["ui_family"] = family
                    r["ui_family_confidence"] = 0.85
                    r["ui_family_source"] = "postprocess_fuzzy"
                    break
        results.append(r)

    OUT.write_text(json.dumps(results, ensure_ascii=False, indent=2))
    print(f"✓ 写 -> {OUT} ({len(results)} 张)")

    # 统计品牌分布
    from collections import Counter
    by_family = Counter(r["ui_family"] for r in results)
    print("\n品牌 × UI 家族分布（用 B 路径后处理后）:")
    for f, c in by_family.most_common():
        print(f"  {f:<12} {c}")


if __name__ == "__main__":
    main()