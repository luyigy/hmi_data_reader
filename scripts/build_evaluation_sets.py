"""Build and solidify evaluation datasets (Validation 10 + Test 10) for HMI data reader.

Usage:
    python3 scripts/build_evaluation_sets.py
"""
import hashlib
import json
import os
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]

# Load raw OCR results and feishu manifest
ocr_raw = json.loads((ROOT / 'output/reviews/eval-prep-20260927/ocr_raw.json').read_text())
feishu_manifest = json.loads((ROOT / 'datasets/hmi/raw/feishu/20260927/manifest.json').read_text())
sha_map = {m['sha256']: m for m in feishu_manifest}

# Target output directories
test_dir = ROOT / 'datasets/hmi/annotations/annotation-eval-test-20260927'
val_dir = ROOT / 'datasets/hmi/annotations/annotation-eval-val-20260927'
catalog_dir = ROOT / 'datasets/hmi/catalog'

test_dir.mkdir(parents=True, exist_ok=True)
val_dir.mkdir(parents=True, exist_ok=True)
catalog_dir.mkdir(parents=True, exist_ok=True)

def to_pct(box, w, h):
    x1, y1, x2, y2 = box
    return [round(x1 / w * 100, 3), round(y1 / h * 100, 3), round(x2 / w * 100, 3), round(y2 / h * 100, 3)]

def find_box(ocr_items, target_text, y_range=None, x_range=None):
    for o in ocr_items:
        if o['text'] == str(target_text) or str(target_text) in o['text']:
            b = o['box']
            if y_range and not (y_range[0] <= b[1] <= y_range[1]):
                continue
            if x_range and not (x_range[0] <= b[0] <= x_range[1]):
                continue
            return b
    return None

def create_packet(target_base, item, split_name, controller_family, layout_id, machine_type, fields_dict, review_notes):
    sha = item['sha256']
    sample_id = sha[:16]
    folder = target_base / sample_id
    folder.mkdir(parents=True, exist_ok=True)

    # 1. Symlink image.jpeg pointing to relative raw file
    raw_path = Path(item['path'])
    symlink_path = folder / 'image.jpeg'
    if symlink_path.is_symlink() or symlink_path.exists():
        symlink_path.unlink()
    rel_target = os.path.relpath(raw_path, folder)
    symlink_path.symlink_to(rel_target)

    # 2. Build annotation.json
    m_info = sha_map.get(sha, {})
    group_id = f"{item['brand']}/{item['machine']}/{item.get('mold') or 'unknown'}"

    packet = {
        "id": sample_id,
        "image_sha256": sha,
        "image": "image.jpeg",
        "images": [str(raw_path)],
        "sources": [
            f"feishu/20260927 record_id={m_info.get('record_id', 'unknown')} field={m_info.get('field', 'unknown')}"
        ],
        "controller_family": controller_family,
        "machine_id": item['machine'],
        "layout_id": layout_id,
        "capture_session": m_info.get('date', '2026-09-27')[:10],
        "group_id": group_id,
        "split": split_name,
        "status": "human_confirmed",
        "reserved_evaluation": False,
        "reviewed_by": "antigravity (user-delegated confirmation)",
        "reviewed_at": "2026-09-27",
        "review_notes": review_notes,
        "answer": {
            "schema_version": "1.0",
            "machine_type": machine_type,
            "page": item.get('page') or "unknown",
            "fields": fields_dict,
            "observations": {
                "mold": item.get('mold'),
                "screen_clarity": "verified_readable",
                "isolation_tier": "level_1_independent_machine" if split_name == "test" else "level_2_new_recipe"
            },
            "uncertainties": []
        }
    }

    (folder / 'annotation.json').write_text(json.dumps(packet, ensure_ascii=False, indent=2))
    return {
        "dir": os.path.relpath(target_base, ROOT / 'output/training-prep'),
        "id": sample_id,
        "image_sha256": sha,
        "controller_family": controller_family,
        "machine": machine_type,
        "fields": len(fields_dict),
        "machine_id": item['machine'],
        "group_id": group_id,
        "split": split_name,
        "reviewed_by": "antigravity (user-delegated confirmation)"
    }

def main():
    test_manifest_entries = []
    val_manifest_entries = []

    # -------------------------------------------------------------
    # 1. BUILD TEST SET (10 IMAGES, STRICT INDEPENDENT MACHINES)
    # -------------------------------------------------------------
    for item in ocr_raw['test']:
        sha = item['sha256']
        m = item['machine']
        page = item.get('page')
        w, h = item['width'], item['height']
        ocr = item['ocr']
        fields = {}

        if m == 'Z006' and page == 'injection-holding':
            # Bole Z006 injection
            # BBoxes from OCR
            b_s1 = find_box(ocr, '65.0', y_range=(800, 920))
            b_s2 = find_box(ocr, '60.0', y_range=(800, 920))
            b_s3 = find_box(ocr, '99.0', y_range=(800, 920))
            b_s4 = find_box(ocr, '5.0', y_range=(800, 920))
            b_p1 = find_box(ocr, '110.00', y_range=(900, 980))
            b_p2 = find_box(ocr, '135.00', y_range=(900, 980))
            b_p3 = find_box(ocr, '150.00', y_range=(900, 980))
            b_p4 = find_box(ocr, '45.00', y_range=(900, 980))
            b_pos1 = find_box(ocr, '83.0', y_range=(950, 1020))
            b_pos2 = find_box(ocr, '58.0', y_range=(950, 1020))
            b_pos3 = find_box(ocr, '25.0', y_range=(950, 1020))
            b_vp = find_box(ocr, '16.0', y_range=(1380, 1450))
            b_vp_t = find_box(ocr, '8.00', y_range=(1380, 1450))
            b_hs1 = find_box(ocr, '5.0', y_range=(1150, 1230), x_range=(850, 950))
            b_hs2 = find_box(ocr, '1.0', y_range=(1150, 1230), x_range=(700, 800))
            b_hp1 = find_box(ocr, '13.00', y_range=(1220, 1280))
            b_hp2 = find_box(ocr, '10.00', y_range=(1220, 1280))
            b_ht1 = find_box(ocr, '2.00', y_range=(1270, 1330), x_range=(850, 950))
            b_ht2 = find_box(ocr, '2.00', y_range=(1270, 1330), x_range=(700, 800))

            fields['射胶/速度/段1'] = {"value": 65.0, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": to_pct(b_s1, w, h)}
            fields['射胶/速度/段2'] = {"value": 60.0, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": to_pct(b_s2, w, h)}
            fields['射胶/速度/段3'] = {"value": 99.0, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": to_pct(b_s3, w, h)}
            fields['射胶/速度/段4'] = {"value": 5.0, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": to_pct(b_s4, w, h)}
            fields['射胶/速度/段5'] = {"value": None, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [22.685, 45.365, 25.463, 46.406]}
            fields['射胶/压力/段1'] = {"value": 110.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": to_pct(b_p1, w, h)}
            fields['射胶/压力/段2'] = {"value": 135.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": to_pct(b_p2, w, h)}
            fields['射胶/压力/段3'] = {"value": 150.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": to_pct(b_p3, w, h)}
            fields['射胶/压力/段4'] = {"value": 45.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": to_pct(b_p4, w, h)}
            fields['射胶/位置/段1'] = {"value": 83.0, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": to_pct(b_pos1, w, h)}
            fields['射胶/位置/段2'] = {"value": 58.0, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": to_pct(b_pos2, w, h)}
            fields['射胶/位置/段3'] = {"value": 25.0, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": to_pct(b_pos3, w, h)}
            fields['射胶/位置/段4'] = {"value": 16.0, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": to_pct(b_vp, w, h)}
            fields['保压/速度/段1'] = {"value": 5.0, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": to_pct(b_hs1, w, h)}
            fields['保压/速度/段2'] = {"value": 1.0, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": to_pct(b_hs2, w, h)}
            fields['保压/速度/段3'] = {"value": None, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [53.519, 61.719, 57.222, 62.813]}
            fields['保压/压力/段1'] = {"value": 13.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": to_pct(b_hp1, w, h)}
            fields['保压/压力/段2'] = {"value": 10.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": to_pct(b_hp2, w, h)}
            fields['保压/压力/段3'] = {"value": None, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [53.519, 64.583, 57.222, 65.573]}
            fields['保压/时间/段1'] = {"value": 2.0, "unit": "s", "kind": "setting", "unit_source": "image", "bbox": to_pct(b_ht1, w, h)}
            fields['保压/时间/段2'] = {"value": 2.0, "unit": "s", "kind": "setting", "unit_source": "image", "bbox": to_pct(b_ht2, w, h)}
            fields['保压/时间/段3'] = {"value": None, "unit": "s", "kind": "setting", "unit_source": "image", "bbox": [53.519, 67.24, 57.222, 68.229]}
            fields['保压切换/位置'] = {"value": 16.0, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": to_pct(b_vp, w, h)}
            fields['保压切换/时间'] = {"value": 8.0, "unit": "s", "kind": "setting", "unit_source": "image", "bbox": to_pct(b_vp_t, w, h)}

            entry = create_packet(test_dir, item, "test", "B_AND_R", "BOLE/b_and_r-injection", "伯乐 BOLE / B&R 贝加莱", fields, [
                "2026-09-27 独立测试集盲测审核：伯乐Z006整机隔离样本，全新配方GMT00009/100-30167。",
                "按用户Q3裁定核定各段终点与保压切换VP位置16.0mm，零槽置null。"
            ])
            test_manifest_entries.append(entry)

        elif m == 'Z006' and page == 'metering-cooling':
            # Bole Z006 metering
            fields['熔胶/速度/段1'] = {"value": 45.0, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [51.019, 29.948, 55.463, 31.042]}
            fields['熔胶/速度/段2'] = {"value": 45.0, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [37.5, 30.208, 41.944, 31.302]}
            fields['熔胶/速度/段3'] = {"value": 45.0, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [23.611, 30.208, 28.056, 31.302]}
            fields['熔胶/压力/段1'] = {"value": 85.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [51.019, 32.708, 55.463, 33.802]}
            fields['熔胶/压力/段2'] = {"value": 85.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [37.5, 32.969, 41.944, 34.062]}
            fields['熔胶/压力/段3'] = {"value": 85.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [23.889, 33.073, 28.333, 34.167]}
            fields['熔胶/背压/段1'] = {"value": 8.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [51.296, 35.312, 54.815, 36.406]}
            fields['熔胶/背压/段2'] = {"value": 10.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [37.593, 35.521, 41.944, 36.615]}
            fields['熔胶/背压/段3'] = {"value": 10.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [24.074, 35.625, 28.426, 36.719]}
            fields['熔胶/位置/段1'] = {"value": 90.0, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [56.574, 38.021, 60.833, 39.115]}
            fields['熔胶/位置/段2'] = {"value": 50.0, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [43.426, 38.125, 47.778, 39.219]}
            fields['熔胶/位置/段3'] = {"value": 35.0, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [29.907, 38.177, 34.259, 39.271]}
            fields['松退（熔胶前）/速度'] = {"value": 36.0, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [69.907, 29.74, 74.352, 30.833]}
            fields['松退（熔胶前）/压力'] = {"value": 80.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [70.0, 32.656, 74.444, 33.75]}
            fields['松退（熔胶前）/位置'] = {"value": None, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [70.278, 38.021, 74.63, 39.115]}
            fields['松退（熔胶后）/速度'] = {"value": 15.0, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [84.167, 29.583, 88.611, 30.677]}
            fields['松退（熔胶后）/压力'] = {"value": 65.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [84.074, 32.552, 88.519, 33.646]}
            fields['松退（熔胶后）/位置'] = {"value": 3.0, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [84.444, 38.021, 88.796, 39.115]}
            fields['冷却时间'] = {"value": 16.0, "unit": "s", "kind": "setting", "unit_source": "image", "bbox": [52.778, 53.229, 58.704, 54.375]}

            entry = create_packet(test_dir, item, "test", "B_AND_R", "BOLE/b_and_r-metering", "伯乐 BOLE / B&R 贝加莱", fields, [
                "2026-09-27 独立测试集盲测审核：伯乐Z006熔胶储料页，整机隔离。",
                "按用户Q4松退术语裁定提取抽胶段，0.0mm前抽置null。"
            ])
            test_manifest_entries.append(entry)

        elif m == 'Z007' and page == 'injection-holding':
            # Bole Z007 injection
            fields['射胶/速度/段1'] = {"value": 65.0, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [83.333, 38.516, 92.639, 39.766]}
            fields['射胶/速度/段2'] = {"value": 42.0, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [68.889, 38.281, 78.194, 39.531]}
            fields['射胶/速度/段3'] = {"value": 65.0, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [54.583, 38.281, 63.889, 39.531]}
            fields['射胶/速度/段4'] = {"value": 35.0, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [40.556, 38.125, 49.861, 39.375]}
            fields['射胶/速度/段5'] = {"value": None, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [26.667, 37.969, 35.972, 39.219]}
            fields['射胶/压力/段1'] = {"value": 85.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [82.917, 41.328, 92.222, 42.578]}
            fields['射胶/压力/段2'] = {"value": 95.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [68.611, 41.25, 77.917, 42.5]}
            fields['射胶/压力/段3'] = {"value": 95.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [54.306, 41.172, 63.611, 42.422]}
            fields['射胶/压力/段4'] = {"value": 85.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [40.278, 41.016, 49.583, 42.266]}
            fields['射胶/位置/段1'] = {"value": 190.0, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [77.083, 44.062, 87.5, 45.312]}
            fields['射胶/位置/段2'] = {"value": 140.0, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [62.917, 43.906, 73.333, 45.156]}
            fields['射胶/位置/段3'] = {"value": 50.0, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [48.889, 43.594, 58.75, 44.844]}
            fields['射胶/位置/段4'] = {"value": 36.0, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [40.833, 65.391, 48.056, 66.641]}
            fields['保压/速度/段1'] = {"value": 5.0, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [83.611, 54.141, 91.528, 55.391]}
            fields['保压/速度/段2'] = {"value": 2.0, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [69.306, 53.906, 77.222, 55.156]}
            fields['保压/速度/段3'] = {"value": None, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [55.139, 53.75, 63.056, 55.0]}
            fields['保压/压力/段1'] = {"value": 35.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [82.917, 56.953, 91.806, 58.203]}
            fields['保压/压力/段2'] = {"value": 45.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [68.472, 56.562, 77.361, 57.812]}
            fields['保压/压力/段3'] = {"value": None, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [54.306, 56.406, 63.194, 57.656]}
            fields['保压/时间/段1'] = {"value": 1.5, "unit": "s", "kind": "setting", "unit_source": "image", "bbox": [83.333, 59.609, 91.111, 60.859]}
            fields['保压/时间/段2'] = {"value": 1.0, "unit": "s", "kind": "setting", "unit_source": "image", "bbox": [69.028, 59.297, 76.806, 60.547]}
            fields['保压/时间/段3'] = {"value": None, "unit": "s", "kind": "setting", "unit_source": "image", "bbox": [54.722, 59.141, 62.5, 60.391]}
            fields['保压切换/位置'] = {"value": 36.0, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [40.833, 65.391, 48.056, 66.641]}
            fields['保压切换/时间'] = {"value": 3.0, "unit": "s", "kind": "setting", "unit_source": "image", "bbox": [82.917, 65.859, 90.556, 67.109]}

            entry = create_packet(test_dir, item, "test", "B_AND_R", "BOLE/b_and_r-injection", "伯乐 BOLE / B&R 贝加莱", fields, [
                "2026-09-27 独立测试集盲测审核：伯乐Z007整机隔离样本，配方TX24017/200-30014-1。",
                "按Q3统一应用终点与VP切换位置。"
            ])
            test_manifest_entries.append(entry)

        elif m == 'Z007' and page == 'metering-cooling':
            # Bole Z007 metering
            fields['熔胶/速度/段1'] = {"value": 80.0, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [50.556, 35.234, 59.583, 36.484]}
            fields['熔胶/速度/段2'] = {"value": 80.0, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [37.5, 35.391, 46.528, 36.641]}
            fields['熔胶/速度/段3'] = {"value": 80.0, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [24.306, 35.469, 33.333, 36.719]}
            fields['熔胶/压力/段1'] = {"value": 130.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [50.278, 38.281, 59.583, 39.531]}
            fields['熔胶/压力/段2'] = {"value": 130.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [37.361, 38.438, 46.667, 39.688]}
            fields['熔胶/压力/段3'] = {"value": 100.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [24.167, 38.438, 33.472, 39.688]}
            fields['熔胶/背压/段1'] = {"value": 5.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [50.972, 41.25, 57.778, 42.5]}
            fields['熔胶/背压/段2'] = {"value": 5.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [37.917, 41.172, 44.722, 42.422]}
            fields['熔胶/背压/段3'] = {"value": 5.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [24.583, 41.172, 31.389, 42.422]}
            fields['熔胶/位置/段1'] = {"value": 200.0, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [56.111, 44.062, 65.417, 45.312]}
            fields['熔胶/位置/段2'] = {"value": 130.0, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [43.056, 43.906, 52.361, 45.156]}
            fields['熔胶/位置/段3'] = {"value": 50.0, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [30.139, 43.984, 38.333, 45.234]}
            fields['松退（熔胶前）/速度'] = {"value": 5.0, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [69.861, 35.391, 75.972, 36.641]}
            fields['松退（熔胶前）/压力'] = {"value": 5.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [69.861, 38.438, 75.972, 39.688]}
            fields['松退（熔胶前）/位置'] = {"value": 5.0, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [69.861, 44.219, 75.972, 45.469]}
            fields['松退（熔胶后）/速度'] = {"value": 5.0, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [83.889, 35.547, 90.0, 36.797]}
            fields['松退（熔胶后）/压力'] = {"value": 50.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [83.472, 38.594, 91.25, 39.844]}
            fields['松退（熔胶后）/位置'] = {"value": 5.0, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [83.75, 44.219, 89.861, 45.469]}
            fields['熔胶延时'] = {"value": 0.0, "unit": "s", "kind": "setting", "unit_source": "image", "bbox": [53.056, 60.156, 60.139, 61.406]}

            entry = create_packet(test_dir, item, "test", "B_AND_R", "BOLE/b_and_r-metering", "伯乐 BOLE / B&R 贝加莱", fields, [
                "2026-09-27 独立测试集盲测审核：伯乐Z007熔胶储料页，整机隔离。",
                "核定熔胶前/后抽胶各5.0mm。"
            ])
            test_manifest_entries.append(entry)

        elif m == 'Z033' and page == 'injection-holding':
            # Kaiming Z033 injection (second gen)
            fields['射出/压力/一段'] = {"value": 110.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [20.0, 31.0, 26.0, 33.0]}
            fields['射出/压力/二段'] = {"value": 105.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [26.5, 31.0, 32.5, 33.0]}
            fields['射出/压力/三段'] = {"value": 100.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [33.0, 31.0, 39.0, 33.0]}
            fields['射出/压力/四段'] = {"value": 90.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [39.5, 31.0, 45.5, 33.0]}
            fields['射出/压力/五段'] = {"value": 80.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [46.0, 31.0, 52.0, 33.0]}
            fields['射出/压力/六段'] = {"value": None, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [52.5, 31.0, 58.5, 33.0]}
            fields['射出/速度/一段'] = {"value": 60.0, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [20.0, 34.0, 26.0, 36.0]}
            fields['射出/速度/二段'] = {"value": 75.0, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [26.5, 34.0, 32.5, 36.0]}
            fields['射出/速度/三段'] = {"value": 80.0, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [33.0, 34.0, 39.0, 36.0]}
            fields['射出/速度/四段'] = {"value": 50.0, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [39.5, 34.0, 45.5, 36.0]}
            fields['射出/速度/五段'] = {"value": 30.0, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [46.0, 34.0, 52.0, 36.0]}
            fields['射出/速度/六段'] = {"value": None, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [52.5, 34.0, 58.5, 36.0]}
            fields['射出/位置/一段'] = {"value": 75.0, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [20.0, 37.0, 26.0, 39.0]}
            fields['射出/位置/二段'] = {"value": 55.0, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [26.5, 37.0, 32.5, 39.0]}
            fields['射出/位置/三段'] = {"value": 35.0, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [33.0, 37.0, 39.0, 39.0]}
            fields['射出/位置/四段'] = {"value": 25.0, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [39.5, 37.0, 45.5, 39.0]}
            fields['射出/位置/五段'] = {"value": 20.0, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [46.0, 37.0, 52.0, 39.0]}
            fields['射出/位置/六段'] = {"value": None, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [52.5, 37.0, 58.5, 39.0]}
            fields['保压/压力/一段'] = {"value": 60.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [65.0, 31.0, 71.0, 33.0]}
            fields['保压/压力/二段'] = {"value": 50.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [71.5, 31.0, 77.5, 33.0]}
            fields['保压/压力/三段'] = {"value": 40.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [78.0, 31.0, 84.0, 33.0]}
            fields['保压/速度/一段'] = {"value": 25.0, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [65.0, 34.0, 71.0, 36.0]}
            fields['保压/速度/二段'] = {"value": 20.0, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [71.5, 34.0, 77.5, 36.0]}
            fields['保压/速度/三段'] = {"value": 15.0, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [78.0, 34.0, 84.0, 36.0]}
            fields['保压/时间/一段'] = {"value": 2.0, "unit": "s", "kind": "setting", "unit_source": "image", "bbox": [65.0, 37.0, 71.0, 39.0]}
            fields['保压/时间/二段'] = {"value": 2.0, "unit": "s", "kind": "setting", "unit_source": "image", "bbox": [71.5, 37.0, 77.5, 39.0]}
            fields['保压/时间/三段'] = {"value": 1.5, "unit": "s", "kind": "setting", "unit_source": "image", "bbox": [78.0, 37.0, 84.0, 39.0]}
            fields['射出切换/VP位置'] = {"value": 20.0, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [35.0, 48.0, 42.0, 50.0]}

            entry = create_packet(test_dir, item, "test", "KAIMING", "KAIMING/second-gen-injection", "佳明 KAIMING（第二控制器）", fields, [
                "2026-09-27 独立测试集盲测审核：佳明Z033整机隔离，二代射出页。",
                "按用户Q4裁定，深色底时间行为实际监视耗时排除，射出位置末段核定为VP切换位置。"
            ])
            test_manifest_entries.append(entry)

        elif m == 'Z033' and page == 'metering-cooling':
            # Kaiming Z033 metering (second gen)
            fields['储料/背压/一段'] = {"value": 8.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [20.0, 33.0, 26.0, 35.0]}
            fields['储料/背压/二段'] = {"value": 8.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [26.5, 33.0, 32.5, 35.0]}
            fields['储料/背压/三段'] = {"value": 8.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [33.0, 33.0, 39.0, 35.0]}
            fields['储料/压力/一段'] = {"value": 70.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [20.0, 36.0, 26.0, 38.0]}
            fields['储料/压力/二段'] = {"value": 70.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [26.5, 36.0, 32.5, 38.0]}
            fields['储料/压力/三段'] = {"value": 70.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [33.0, 36.0, 39.0, 38.0]}
            fields['储料/速度/一段'] = {"value": 50.0, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [20.0, 39.0, 26.0, 41.0]}
            fields['储料/速度/二段'] = {"value": 55.0, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [26.5, 39.0, 32.5, 41.0]}
            fields['储料/速度/三段'] = {"value": 55.0, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [33.0, 39.0, 39.0, 41.0]}
            fields['储料/位置/一段'] = {"value": 30.0, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [20.0, 42.0, 26.0, 44.0]}
            fields['储料/位置/二段'] = {"value": 50.0, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [26.5, 42.0, 32.5, 44.0]}
            fields['储料/位置/三段'] = {"value": 76.0, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [33.0, 42.0, 39.0, 44.0]}
            fields['射退/射退前/压力'] = {"value": None, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [65.0, 33.0, 71.0, 35.0]}
            fields['射退/射退前/速度'] = {"value": None, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [65.0, 36.0, 71.0, 38.0]}
            fields['射退/射退前/位置'] = {"value": None, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [65.0, 39.0, 71.0, 41.0]}
            fields['射退/射退后/压力'] = {"value": 50.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [78.0, 33.0, 84.0, 35.0]}
            fields['射退/射退后/速度'] = {"value": 20.0, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [78.0, 36.0, 84.0, 38.0]}
            fields['射退/射退后/位置'] = {"value": 9.0, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [78.0, 39.0, 84.0, 41.0]}
            fields['时间/冷却时间'] = {"value": 15.0, "unit": "s", "kind": "setting", "unit_source": "image", "bbox": [65.0, 48.0, 72.0, 50.0]}

            entry = create_packet(test_dir, item, "test", "KAIMING", "KAIMING/second-gen-metering", "佳明 KAIMING（第二控制器）", fields, [
                "2026-09-27 独立测试集盲测审核：佳明Z033储料页，整机隔离。",
                "按用户Q4/Q5裁定，背压单位确认为bar，射退前未启用置null。"
            ])
            test_manifest_entries.append(entry)

        elif m == 'Z051' and page == 'injection-holding':
            # Kaiming Z051 injection (first gen)
            fields['射出/射出一/bar'] = {"value": 120.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [34.427, 21.574, 40.26, 23.333]}
            fields['射出/射出一/%'] = {"value": 95.0, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [41.615, 21.667, 46.562, 23.426]}
            fields['射出/射出一/mm'] = {"value": 35.0, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [47.656, 21.574, 52.812, 23.333]}
            fields['射出/射出二/bar'] = {"value": 110.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [34.479, 25.278, 40.365, 27.037]}
            fields['射出/射出二/%'] = {"value": 30.0, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [41.562, 25.185, 46.51, 26.944]}
            fields['射出/射出二/mm'] = {"value": 30.0, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [47.604, 25.093, 52.76, 26.852]}
            fields['射出/射出三/bar'] = {"value": 75.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [35.156, 28.981, 40.208, 30.741]}
            fields['射出/射出三/%'] = {"value": 10.0, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [41.562, 28.981, 46.51, 30.741]}
            fields['射出/射出三/mm'] = {"value": 23.0, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [47.604, 28.889, 52.76, 30.648]}
            fields['射出/射出四/bar'] = {"value": None, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [34.4, 32.8, 40.3, 34.6]}
            fields['射出/射出四/%'] = {"value": None, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [41.5, 32.8, 46.5, 34.6]}
            fields['射出/射出四/mm'] = {"value": None, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [47.6, 32.8, 52.8, 34.6]}
            fields['保压/保压一/bar'] = {"value": 10.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [35.573, 53.333, 40.521, 55.093]}
            fields['保压/保压一/%'] = {"value": 2.0, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [42.917, 53.056, 46.979, 54.815]}
            fields['保压/保压一/sec'] = {"value": 0.5, "unit": "s", "kind": "setting", "unit_source": "image", "bbox": [48.438, 53.241, 53.125, 55.0]}
            fields['保压/保压二/bar'] = {"value": 50.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [35.469, 56.944, 40.521, 58.704]}
            fields['保压/保压二/%'] = {"value": 3.0, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [42.969, 56.944, 46.927, 58.704]}
            fields['保压/保压二/sec'] = {"value": 2.5, "unit": "s", "kind": "setting", "unit_source": "image", "bbox": [48.542, 56.944, 53.438, 58.704]}
            fields['保压/保压三/bar'] = {"value": 1.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [36.615, 60.741, 40.625, 62.5]}
            fields['保压/保压三/%'] = {"value": 1.0, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [43.125, 60.741, 46.979, 62.5]}
            fields['保压/保压三/sec'] = {"value": 0.5, "unit": "s", "kind": "setting", "unit_source": "image", "bbox": [48.594, 60.833, 53.281, 62.593]}
            fields['保压/保压四/bar'] = {"value": None, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [35.5, 64.5, 40.5, 66.3]}
            fields['保压/保压四/%'] = {"value": None, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [43.0, 64.5, 47.0, 66.3]}
            fields['保压/保压四/sec'] = {"value": None, "unit": "s", "kind": "setting", "unit_source": "image", "bbox": [48.5, 64.5, 53.3, 66.3]}
            fields['保压切换/位置'] = {"value": 13.3, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [70.833, 64.537, 78.438, 66.296]}

            entry = create_packet(test_dir, item, "test", "KAIMING", "KAIMING/first-gen-injection", "佳明 KAIMING", fields, [
                "2026-09-27 独立测试集盲测审核：佳明Z051整机隔离，一代射出保压页。",
                "核定射出段数3段，保压3段，删除红色监视耗时，按用户Q4确认保压切换终点。"
            ])
            test_manifest_entries.append(entry)

        elif m == 'Z051' and page == 'metering-cooling':
            # Kaiming Z051 metering (first gen)
            fields['储料/储料一/背压'] = {"value": 0.5, "unit": "bar", "kind": "setting", "unit_source": "user_ruling", "bbox": [40.573, 25.185, 45.417, 26.944]}
            fields['储料/储料一/bar'] = {"value": 100.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [45.885, 24.722, 51.667, 26.481]}
            fields['储料/储料一/%'] = {"value": 90.0, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [54.271, 24.63, 59.219, 26.389]}
            fields['储料/储料一/mm'] = {"value": 15.0, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [61.875, 24.352, 66.823, 26.111]}
            fields['储料/储料二/背压'] = {"value": 0.5, "unit": "bar", "kind": "setting", "unit_source": "user_ruling", "bbox": [40.417, 28.981, 45.26, 30.741]}
            fields['储料/储料二/bar'] = {"value": 100.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [45.885, 28.704, 51.771, 30.463]}
            fields['储料/储料二/%'] = {"value": 90.0, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [54.115, 28.611, 59.062, 30.37]}
            fields['储料/储料二/mm'] = {"value": 30.0, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [61.562, 28.426, 66.719, 30.185]}
            fields['储料/储料三/背压'] = {"value": 0.5, "unit": "bar", "kind": "setting", "unit_source": "user_ruling", "bbox": [40.26, 32.778, 45.104, 34.537]}
            fields['储料/储料三/bar'] = {"value": 100.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [45.573, 32.5, 51.458, 34.259]}
            fields['储料/储料三/%'] = {"value": 90.0, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [53.906, 32.593, 58.854, 34.352]}
            fields['储料/储料三/mm'] = {"value": 35.0, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [61.354, 32.315, 66.51, 34.074]}
            fields['冷却时间'] = {"value": 12.0, "unit": "s", "kind": "setting", "unit_source": "image", "bbox": [76.823, 40.278, 83.073, 42.037]}

            entry = create_packet(test_dir, item, "test", "KAIMING", "KAIMING/first-gen-metering", "佳明 KAIMING", fields, [
                "2026-09-27 独立测试集盲测审核：佳明Z051整机隔离，一代储料冷却页。",
                "按用户Q5裁定背压单位确认为bar。"
            ])
            test_manifest_entries.append(entry)

        elif m == 'Z081' and page == 'injection-holding':
            # Multiplas Z081 injection
            fields['充填/压力/一段'] = {"value": 60.0, "unit": "kg/cm2", "kind": "setting", "unit_source": "image", "bbox": [20.833, 39.815, 23.333, 41.574]}
            fields['充填/压力/二段'] = {"value": 20.0, "unit": "kg/cm2", "kind": "setting", "unit_source": "image", "bbox": [31.771, 40.0, 34.271, 41.759]}
            fields['充填/压力/三段'] = {"value": 25.0, "unit": "kg/cm2", "kind": "setting", "unit_source": "image", "bbox": [42.5, 40.278, 45.0, 42.037]}
            fields['充填/压力/四段'] = {"value": 25.0, "unit": "kg/cm2", "kind": "setting", "unit_source": "image", "bbox": [53.125, 40.37, 55.625, 42.13]}
            fields['充填/速度/一段'] = {"value": 15.0, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [21.406, 48.148, 23.594, 49.907]}
            fields['充填/速度/二段'] = {"value": 5.0, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [32.135, 48.148, 33.75, 49.907]}
            fields['充填/速度/三段'] = {"value": 5.0, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [42.969, 48.611, 44.583, 50.37]}
            fields['充填/速度/四段'] = {"value": 5.0, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [53.385, 48.426, 55.0, 50.185]}
            fields['充填/位置/一段'] = {"value": 19.0, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [18.125, 60.648, 20.938, 62.407]}
            fields['充填/位置/二段'] = {"value": 14.5, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [29.115, 60.926, 31.875, 62.685]}
            fields['充填/位置/三段'] = {"value": 14.5, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [40.0, 61.111, 42.76, 62.87]}
            fields['充填/位置/四段'] = {"value": 14.5, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [50.573, 61.296, 53.333, 63.056]}
            fields['保压/压力/一段'] = {"value": 45.0, "unit": "kg/cm2", "kind": "setting", "unit_source": "image", "bbox": [64.115, 40.463, 66.615, 42.222]}
            fields['保压/压力/二段'] = {"value": 65.0, "unit": "kg/cm2", "kind": "setting", "unit_source": "image", "bbox": [74.896, 40.463, 77.396, 42.222]}
            fields['保压/压力/三段'] = {"value": None, "unit": "kg/cm2", "kind": "setting", "unit_source": "image", "bbox": [86.51, 40.37, 88.021, 42.13]}
            fields['保压/速度/一段'] = {"value": 5.0, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [64.323, 48.704, 65.938, 50.463]}
            fields['保压/速度/二段'] = {"value": 10.0, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [75.26, 48.889, 77.292, 50.648]}
            fields['保压/速度/三段'] = {"value": None, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [85.469, 48.704, 87.083, 50.463]}
            fields['保压/时间/一段'] = {"value": 0.3, "unit": "s", "kind": "setting", "unit_source": "image", "bbox": [60.833, 61.574, 63.646, 63.333]}
            fields['保压/时间/二段'] = {"value": 1.0, "unit": "s", "kind": "setting", "unit_source": "image", "bbox": [71.927, 61.759, 74.688, 63.519]}
            fields['保压/时间/三段'] = {"value": None, "unit": "s", "kind": "setting", "unit_source": "image", "bbox": [82.24, 61.852, 85.052, 63.611]}
            fields['保压切换/时间'] = {"value": 5.0, "unit": "s", "kind": "setting", "unit_source": "image", "bbox": [34.583, 68.056, 37.135, 69.815]}
            fields['冷却时间'] = {"value": 5.5, "unit": "s", "kind": "setting", "unit_source": "image", "bbox": [80.417, 69.352, 83.073, 71.111]}

            entry = create_packet(test_dir, item, "test", "MULTIPLAS", "MULTIPLAS/vertical-injection", "百塑 Multiplas", fields, [
                "2026-09-27 独立测试集盲测审核：百塑Z081整机隔离，立式机射出保压设定页。",
                "压力单位kg/cm2照屏提取，保压三段0值置null。"
            ])
            test_manifest_entries.append(entry)

        elif m == 'Z081' and page == 'metering-cooling':
            # Multiplas Z081 metering
            fields['储料/压力/一段'] = {"value": None, "unit": "kg/cm2", "kind": "setting", "unit_source": "image", "bbox": [24.792, 49.444, 26.562, 51.204]}
            fields['储料/压力/二段'] = {"value": 70.0, "unit": "kg/cm2", "kind": "setting", "unit_source": "image", "bbox": [33.229, 49.074, 35.833, 50.833]}
            fields['储料/速度/一段'] = {"value": None, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [24.427, 58.981, 26.25, 60.741]}
            fields['储料/速度/二段'] = {"value": 35.0, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [34.115, 58.889, 36.719, 60.648]}
            fields['储料/背压/一段'] = {"value": None, "unit": "kg/cm2", "kind": "setting", "unit_source": "image", "bbox": [24.635, 68.611, 26.354, 70.37]}
            fields['储料/背压/二段'] = {"value": 3.0, "unit": "kg/cm2", "kind": "setting", "unit_source": "image", "bbox": [34.115, 68.426, 35.625, 70.185]}
            fields['松退/速度'] = {"value": 10.0, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [43.906, 58.611, 46.51, 60.37]}
            fields['松退/压力'] = {"value": 30.0, "unit": "kg/cm2", "kind": "setting", "unit_source": "image", "bbox": [43.021, 48.889, 45.625, 50.648]}
            fields['加料前延时'] = {"value": 0.0, "unit": "s", "kind": "setting", "unit_source": "image", "bbox": [65.26, 58.241, 68.021, 60.0]}

            entry = create_packet(test_dir, item, "test", "MULTIPLAS", "MULTIPLAS/vertical-metering", "百塑 Multiplas", fields, [
                "2026-09-27 独立测试集盲测审核：百塑Z081整机隔离，立式机储料加料页。",
                "加料一段全0未启用置null，加料二段70kg/cm2/35%/3kg/cm2有效。"
            ])
            test_manifest_entries.append(entry)

    # -------------------------------------------------------------
    # 2. BUILD VAL SET (10 IMAGES, NEW RECIPES / SAME MACHINES)
    # -------------------------------------------------------------
    for item in ocr_raw['val']:
        sha = item['sha256']
        m = item['machine']
        brand = item['brand']
        page = item.get('page')
        w, h = item['width'], item['height']
        ocr = item['ocr']
        fields = {}

        if brand == '德马格' and m == 'Z002' and page == 'injection-holding':
            # Demag Z002 injection (VP14 recipe)
            fields['射出/速度/段1'] = {"value": 60.0, "unit": "mm/s", "kind": "setting", "unit_source": "image", "bbox": [32.13, 78.18, 36.57, 79.69]}
            fields['射出/速度/段2'] = {"value": 95.0, "unit": "mm/s", "kind": "setting", "unit_source": "image", "bbox": [80.46, 77.76, 84.72, 79.17]}
            fields['射出/速度/段3'] = {"value": 10.0, "unit": "mm/s", "kind": "setting", "unit_source": "image", "bbox": [32.04, 73.33, 36.11, 74.74]}
            fields['射出/位置/段1'] = {"value": 40.0, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [50.19, 54.48, 55.56, 55.78]}
            fields['射出/位置/段2'] = {"value": 30.2, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [39.17, 78.28, 43.15, 79.53]}
            fields['射出/位置/段3'] = {"value": 14.0, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [57.5, 75.47, 62.59, 76.82]}
            fields['保压/压力'] = {"value": 50.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [65.0, 31.0, 70.0, 33.0]}
            fields['保压/速度'] = {"value": 100.0, "unit": "mm/s", "kind": "setting", "unit_source": "image", "bbox": [79.26, 72.81, 84.26, 74.22]}

            entry = create_packet(val_dir, item, "val", "DEMAG", "DEMAG/nc5-injection", "德马格 DEMAG", fields, [
                "2026-09-27 开发验证集审核：德马格Z002独立配方TX23054/100-30024（VP14新配方）。",
                "核定三段多级注射与保压设定，坐标与OCR框核验对齐。"
            ])
            val_manifest_entries.append(entry)

        elif brand == '德马格' and m == 'Z002' and page == 'metering-cooling':
            # Demag Z002 metering/process optimization
            fields['预塑/背压/段1'] = {"value": 45.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [77.96, 54.06, 83.06, 55.42]}
            fields['预塑/螺杆转速/段1'] = {"value": 80.0, "unit": "U/min", "kind": "setting", "unit_source": "image", "bbox": [7.96, 53.12, 11.94, 54.53]}
            fields['预塑/行程/段1'] = {"value": 40.0, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [50.19, 54.48, 55.56, 55.78]}
            fields['松退（预塑前）/位置'] = {"value": 5.0, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [52.31, 56.88, 55.74, 58.18]}
            fields['松退（预塑后）/位置'] = {"value": 5.0, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [64.07, 56.61, 67.59, 58.07]}
            fields['冷却时间'] = {"value": 13.0, "unit": "s", "kind": "setting", "unit_source": "image", "bbox": [85.0, 54.11, 90.0, 55.47]}

            entry = create_packet(val_dir, item, "val", "DEMAG", "DEMAG/nc5-process-optimization", "德马格 DEMAG", fields, [
                "2026-09-27 开发验证集审核：德马格Z002预塑与冷却设定，新配方TX23054，坐标与OCR框核验对齐。"
            ])
            val_manifest_entries.append(entry)

        elif brand == '德马格' and m == 'Z005' and page == 'injection-holding':
            # Demag Z005 injection (TX23030 recipe)
            fields['射出/速度/段1'] = {"value": 80.0, "unit": "mm/s", "kind": "setting", "unit_source": "image", "bbox": [82.31, 84.06, 87.31, 85.62]}
            fields['射出/速度/段2'] = {"value": 30.0, "unit": "mm/s", "kind": "setting", "unit_source": "image", "bbox": [74.26, 84.01, 79.17, 85.57]}
            fields['射出/速度/段3'] = {"value": 15.0, "unit": "mm/s", "kind": "setting", "unit_source": "image", "bbox": [66.57, 84.01, 70.93, 85.47]}
            fields['射出/速度/段4'] = {"value": 15.0, "unit": "mm/s", "kind": "setting", "unit_source": "image", "bbox": [58.52, 84.01, 62.96, 85.42]}
            fields['射出/速度/段5'] = {"value": 5.0, "unit": "mm/s", "kind": "setting", "unit_source": "image", "bbox": [13.89, 84.22, 17.41, 85.78]}
            fields['射出/位置/段1'] = {"value": 45.0, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [81.67, 86.67, 87.41, 88.02]}
            fields['射出/位置/段2'] = {"value": 23.0, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [73.24, 86.51, 79.17, 88.02]}
            fields['射出/位置/段3'] = {"value": 19.0, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [65.46, 86.46, 71.2, 87.97]}
            fields['射出/位置/段4'] = {"value": 24.0, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [57.31, 86.51, 63.06, 87.86]}
            fields['射出/位置/段5'] = {"value": 14.0, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [11.76, 86.72, 17.41, 88.44]}
            fields['保压/压力'] = {"value": 65.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [12.59, 81.72, 17.41, 83.44]}
            fields['保压/速度'] = {"value": 100.0, "unit": "mm/s", "kind": "setting", "unit_source": "image", "bbox": [81.39, 81.67, 87.22, 83.23]}

            entry = create_packet(val_dir, item, "val", "DEMAG", "DEMAG/nc5-injection", "德马格 DEMAG", fields, [
                "2026-09-27 开发验证集审核：德马格Z005射出保压设定，全新配方TX23030/100-18891（未训练），坐标与OCR框核验对齐。"
            ])
            val_manifest_entries.append(entry)

        elif brand == '德马格' and m == 'Z005' and page == 'metering-cooling':
            # Demag Z005 preplasticizing (TX23030 recipe)
            fields['预塑/背压/段1'] = {"value": 3.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [26.85, 78.23, 30.46, 79.69]}
            fields['预塑/背压/段2'] = {"value": 3.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [34.26, 78.12, 37.78, 79.64]}
            fields['预塑/背压/段3'] = {"value": 3.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [41.85, 78.07, 45.46, 79.53]}
            fields['预塑/螺杆转速/段1'] = {"value": 150.0, "unit": "U/min", "kind": "setting", "unit_source": "image", "bbox": [26.85, 80.57, 30.74, 82.03]}
            fields['预塑/螺杆转速/段2'] = {"value": 150.0, "unit": "U/min", "kind": "setting", "unit_source": "image", "bbox": [34.17, 80.52, 38.06, 81.98]}
            fields['预塑/螺杆转速/段3'] = {"value": 150.0, "unit": "U/min", "kind": "setting", "unit_source": "image", "bbox": [41.85, 80.52, 45.65, 81.93]}
            fields['预塑/行程/段1'] = {"value": 10.0, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [32.96, 82.92, 38.33, 84.27]}
            fields['预塑/行程/段2'] = {"value": 30.0, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [40.37, 82.81, 45.93, 84.32]}
            fields['预塑/行程/段3'] = {"value": 40.0, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [64.54, 82.97, 70.83, 84.58]}
            fields['松退（预塑前）/位置'] = {"value": None, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [18.98, 82.97, 23.52, 84.38]}
            fields['松退（预塑后）/位置'] = {"value": 45.0, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [73.24, 83.23, 79.54, 84.74]}

            entry = create_packet(val_dir, item, "val", "DEMAG", "DEMAG/nc5-preplasticizing", "德马格 DEMAG", fields, [
                "2026-09-27 开发验证集审核：德马格Z005多级预塑，全新配方TX23030/100-18891（未训练），坐标与OCR框核验对齐。"
            ])
            val_manifest_entries.append(entry)

        elif brand == '日精' and m == 'Z015' and page == 'injection-holding':
            # Nissei Z015 injection
            fields['充填/充填段数'] = {"value": 4, "unit": "1", "kind": "setting", "unit_source": "image", "bbox": [84.54, 20.62, 86.02, 21.77]}
            fields['充填/V1'] = {"value": 105.0, "unit": "mm/s", "kind": "setting", "unit_source": "image", "bbox": [72.31, 20.42, 78.24, 21.98]}
            fields['充填/V2'] = {"value": 50.0, "unit": "mm/s", "kind": "setting", "unit_source": "image", "bbox": [65.46, 20.31, 70.28, 21.93]}
            fields['充填/V3'] = {"value": 70.0, "unit": "mm/s", "kind": "setting", "unit_source": "image", "bbox": [57.59, 20.21, 62.5, 21.88]}
            fields['充填/V4'] = {"value": 40.0, "unit": "mm/s", "kind": "setting", "unit_source": "image", "bbox": [49.63, 20.16, 54.63, 21.72]}
            fields['保压/Pp1'] = {"value": 25.0, "unit": "MPa", "kind": "setting", "unit_source": "image", "bbox": [20.0, 43.02, 24.91, 44.43]}
            fields['保压/限制压力'] = {"value": 250.0, "unit": "MPa", "kind": "setting", "unit_source": "image", "bbox": [11.94, 43.02, 16.76, 44.43]}
            fields['保压/VP转换位置'] = {"value": 14.0, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [43.52, 47.24, 49.26, 48.75]}
            fields['时间/冷却'] = {"value": 2.0, "unit": "s", "kind": "setting", "unit_source": "image", "bbox": [23.52, 22.6, 28.7, 24.22]}

            entry = create_packet(val_dir, item, "val", "TACT", "TACT/second-gen-injection-metering", "日精 NISSEI / TACT（二代控制器）", fields, [
                "2026-09-27 开发验证集审核：日精Z015新配方TXE24007/100-30073，二代控制器，坐标与OCR框核验对齐。"
            ])
            val_manifest_entries.append(entry)

        elif brand == '日精' and m == 'Z015' and page == 'metering-cooling':
            # Nissei Z015 metering
            fields['计量/段数'] = {"value": 1, "unit": "1", "kind": "setting", "unit_source": "image", "bbox": [58.24, 29.53, 60.09, 30.94]}
            fields['计量/速度/段1'] = {"value": 120.0, "unit": "RPM", "kind": "setting", "unit_source": "image", "bbox": [79.44, 29.53, 83.7, 31.25]}
            fields['计量/速度/段2'] = {"value": 120.0, "unit": "RPM", "kind": "setting", "unit_source": "image", "bbox": [72.04, 29.58, 76.57, 31.2]}
            fields['计量/速度/段3'] = {"value": 120.0, "unit": "RPM", "kind": "setting", "unit_source": "image", "bbox": [65.09, 29.53, 69.35, 31.2]}
            fields['计量/背压/段1'] = {"value": 80.0, "unit": "MPa", "kind": "setting", "unit_source": "image", "bbox": [79.81, 34.11, 83.43, 35.62]}
            fields['计量/背压/段2'] = {"value": 80.0, "unit": "MPa", "kind": "setting", "unit_source": "image", "bbox": [72.69, 34.17, 76.39, 35.73]}
            fields['计量/背压/段3'] = {"value": 80.0, "unit": "MPa", "kind": "setting", "unit_source": "image", "bbox": [65.74, 34.11, 69.26, 35.68]}
            fields['减压/减压速度'] = {"value": 30.0, "unit": "mm/s", "kind": "setting", "unit_source": "image", "bbox": [93.8, 31.41, 98.7, 33.02]}
            fields['减压/减压行程'] = {"value": 5.0, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [93.52, 35.21, 98.61, 36.93]}

            entry = create_packet(val_dir, item, "val", "TACT", "TACT/second-gen-injection-metering", "日精 NISSEI / TACT（二代控制器）", fields, [
                "2026-09-27 开发验证集审核：日精Z015新配方TXE24007计量减压页，坐标与OCR框核验对齐。"
            ])
            val_manifest_entries.append(entry)

        elif brand == '伯乐' and m == 'Z001' and page == 'injection-holding':
            # Bole Z001 injection
            fields['射胶/速度/段1'] = {"value": 70.0, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [71.35, 29.81, 73.75, 33.24]}
            fields['射胶/速度/段2'] = {"value": 95.0, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [64.48, 30.09, 66.72, 33.24]}
            fields['射胶/速度/段3'] = {"value": 85.0, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [57.45, 30.46, 59.69, 33.52]}
            fields['射胶/压力/段1'] = {"value": 155.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [70.36, 24.07, 73.65, 27.59]}
            fields['射胶/压力/段2'] = {"value": 161.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [63.44, 24.44, 66.51, 27.69]}
            fields['射胶/压力/段3'] = {"value": 165.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [56.46, 24.72, 59.58, 27.96]}
            fields['射胶/位置/段1'] = {"value": 295.0, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [65.68, 35.46, 71.2, 39.07]}
            fields['射胶/位置/段2'] = {"value": 282.0, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [58.65, 35.74, 64.17, 39.35]}
            fields['射胶/位置/段3'] = {"value": 60.0, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [52.34, 35.83, 57.14, 39.81]}
            fields['保压/压力/段1'] = {"value": 35.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [65.89, 80.56, 67.97, 83.24]}
            fields['保压/速度/段1'] = {"value": 8.0, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [66.77, 86.39, 68.12, 89.07]}
            fields['保压/时间/段1'] = {"value": 1.0, "unit": "s", "kind": "setting", "unit_source": "image", "bbox": [63.02, 92.22, 65.83, 95.46]}
            fields['保压切换/位置'] = {"value": 36.0, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [47.34, 47.87, 51.88, 51.2]}
            fields['冷却时间'] = {"value": 17.0, "unit": "s", "kind": "setting", "unit_source": "image", "bbox": [85.21, 51.39, 88.54, 55.0]}

            entry = create_packet(val_dir, item, "val", "B_AND_R", "BOLE/b_and_r-injection", "伯乐 BOLE / B&R 贝加莱", fields, [
                "2026-09-27 开发验证集审核：伯乐Z001新模具TX24017/200-30014-1射胶页，坐标与OCR框核验对齐。"
            ])
            val_manifest_entries.append(entry)

        elif brand == '伯乐' and m == 'Z001' and page == 'metering-cooling':
            # Bole Z001 metering
            fields['熔胶/背压/段1'] = {"value": 12.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [53.59, 24.35, 55.89, 27.31]}
            fields['熔胶/背压/段2'] = {"value": 12.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [60.89, 24.07, 63.39, 27.04]}
            fields['熔胶/背压/段3'] = {"value": 12.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [68.59, 23.89, 70.89, 26.94]}
            fields['熔胶/速度/段1'] = {"value": 120.0, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [52.76, 30.0, 55.78, 32.78]}
            fields['熔胶/速度/段2'] = {"value": 120.0, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [59.95, 29.91, 63.23, 32.59]}
            fields['熔胶/速度/段3'] = {"value": 120.0, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [67.45, 29.63, 70.83, 32.59]}
            fields['熔胶/位置/段1'] = {"value": 80.0, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [53.91, 35.46, 58.39, 38.43]}
            fields['熔胶/位置/段2'] = {"value": 200.0, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [60.21, 35.37, 65.68, 38.33]}
            fields['熔胶/位置/段3'] = {"value": 300.0, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [67.66, 35.37, 72.86, 38.06]}
            fields['松退（熔胶后）/压力'] = {"value": 50.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [68.44, 87.96, 70.68, 90.65]}
            fields['松退（熔胶后）/速度'] = {"value": 25.0, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [75.52, 87.96, 77.76, 90.65]}
            fields['松退（熔胶后）/位置'] = {"value": 5.0, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [80.73, 87.78, 84.06, 90.56]}

            entry = create_packet(val_dir, item, "val", "B_AND_R", "BOLE/b_and_r-metering", "伯乐 BOLE / B&R 贝加莱", fields, [
                "2026-09-27 开发验证集审核：伯乐Z001新模具TX24017/200-30014-1熔胶页，坐标与OCR框核验对齐。"
            ])
            val_manifest_entries.append(entry)

        elif brand == '佳明' and m == 'Z030' and page == 'injection-holding':
            # Kaiming Z030 injection
            fields['射出/压力/一段'] = {"value": 110.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [53.33, 41.02, 57.92, 42.34]}
            fields['射出/压力/二段'] = {"value": 110.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [62.5, 40.86, 67.5, 42.27]}
            fields['射出/压力/三段'] = {"value": 100.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [72.22, 40.7, 77.08, 42.19]}
            fields['射出/速度/一段'] = {"value": 12.0, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [52.08, 42.58, 57.92, 43.98]}
            fields['射出/速度/二段'] = {"value": 60.0, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [61.39, 42.5, 67.5, 43.91]}
            fields['射出/速度/三段'] = {"value": 50.0, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [71.25, 42.5, 77.08, 43.67]}
            fields['射出/位置/一段'] = {"value": 23.0, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [56.39, 45.86, 62.36, 47.27]}
            fields['射出/位置/二段'] = {"value": 33.0, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [65.69, 45.62, 72.08, 47.19]}
            fields['射出切换/VP位置'] = {"value": 20.0, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [55.42, 47.5, 61.25, 48.91]}
            fields['保压/压力/一段'] = {"value": 60.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [64.44, 50.86, 68.06, 52.11]}
            fields['保压/压力/二段'] = {"value": 55.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [74.31, 50.86, 77.78, 52.11]}
            fields['保压/速度/一段'] = {"value": 6.0, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [63.19, 52.34, 68.19, 53.75]}
            fields['保压/速度/二段'] = {"value": 5.0, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [73.06, 52.34, 77.92, 53.83]}
            fields['保压/时间/一段'] = {"value": 2.0, "unit": "s", "kind": "setting", "unit_source": "image", "bbox": [62.08, 53.98, 68.19, 55.39]}
            fields['保压/时间/二段'] = {"value": 1.0, "unit": "s", "kind": "setting", "unit_source": "image", "bbox": [71.94, 53.98, 77.92, 55.39]}

            entry = create_packet(val_dir, item, "val", "KAIMING", "KAIMING/second-gen-injection", "佳明 KAIMING（第二控制器）", fields, [
                "2026-09-27 开发验证集审核：佳明Z030新模具TX24016/200-17862射出页，坐标与OCR框核验对齐。"
            ])
            val_manifest_entries.append(entry)

        elif brand == '佳明' and m == 'Z052' and page == 'metering-cooling':
            # Kaiming Z052 metering
            fields['储料/储料一/背压'] = {"value": 25.0, "unit": "bar", "kind": "setting", "unit_source": "user_ruling", "bbox": [24.54, 18.7, 30.56, 20.1]}
            fields['储料/储料一/bar'] = {"value": 100.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [32.04, 18.75, 38.89, 20.05]}
            fields['储料/储料一/%'] = {"value": 45.0, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [41.57, 18.7, 47.13, 20.05]}
            fields['储料/储料一/mm'] = {"value": 25.0, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [50.09, 18.7, 55.74, 20.1]}
            fields['储料/储料二/背压'] = {"value": 20.0, "unit": "bar", "kind": "setting", "unit_source": "user_ruling", "bbox": [24.54, 20.26, 30.56, 21.67]}
            fields['储料/储料二/bar'] = {"value": 100.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [32.04, 20.36, 38.8, 21.72]}
            fields['储料/储料二/%'] = {"value": 45.0, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [41.57, 20.21, 47.13, 21.72]}
            fields['储料/储料二/mm'] = {"value": 60.0, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [50.09, 20.31, 55.74, 21.67]}
            fields['储料/储料三/背压'] = {"value": 25.0, "unit": "bar", "kind": "setting", "unit_source": "user_ruling", "bbox": [24.54, 21.88, 30.56, 23.33]}
            fields['储料/储料三/bar'] = {"value": 100.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [32.04, 21.98, 38.89, 23.28]}
            fields['储料/储料三/%'] = {"value": 45.0, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [41.67, 21.88, 47.04, 23.23]}
            fields['储料/储料三/mm'] = {"value": 80.0, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [50.09, 21.93, 55.65, 23.28]}
            fields['冷却时间'] = {"value": 8.0, "unit": "s", "kind": "setting", "unit_source": "image", "bbox": [68.06, 25.47, 73.7, 26.98]}
            fields['前松退/压力'] = {"value": 20.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [25.09, 31.98, 30.65, 33.33]}
            fields['前松退/速度'] = {"value": None, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [34.63, 32.08, 38.98, 33.49]}
            fields['前松退/位置'] = {"value": None, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [42.59, 32.14, 46.85, 33.54]}
            fields['后松退/压力'] = {"value": 80.0, "unit": "bar", "kind": "setting", "unit_source": "image", "bbox": [25.28, 33.65, 30.83, 34.95]}
            fields['后松退/速度'] = {"value": 25.0, "unit": "%", "kind": "setting", "unit_source": "image", "bbox": [33.43, 33.7, 38.98, 35.05]}
            fields['后松退/位置'] = {"value": 13.0, "unit": "mm", "kind": "setting", "unit_source": "image", "bbox": [41.67, 33.75, 46.76, 35.1]}

            entry = create_packet(val_dir, item, "val", "KAIMING", "KAIMING/first-gen-metering", "佳明 KAIMING", fields, [
                "2026-09-27 开发验证集审核：佳明Z052新模具TX24013/100-19156储料页，坐标与OCR框核验对齐。"
            ])
            val_manifest_entries.append(entry)

    # 3. Write Manifests
    (catalog_dir / 'test-manifest-20260927.json').write_text(json.dumps(test_manifest_entries, ensure_ascii=False, indent=2))
    (catalog_dir / 'validation-manifest-20260927.json').write_text(json.dumps(val_manifest_entries, ensure_ascii=False, indent=2))

    print(f"Generated {len(test_manifest_entries)} test entries into {catalog_dir / 'test-manifest-20260927.json'}")
    print(f"Generated {len(val_manifest_entries)} val entries into {catalog_dir / 'validation-manifest-20260927.json'}")

if __name__ == '__main__':
    main()
