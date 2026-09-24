"""Build a portable human-review packet; never overwrite edited annotations.

Run: python3 scripts/prepare_training_packet.py [--output DIRECTORY]
The existing review.jsonl remains the source inventory, not training gold.
"""
import argparse
import hashlib
import html
import json
import shutil
from pathlib import Path

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path, default=root / 'output/training-prep/annotation-packet')
args = parser.parse_args()
out = args.output
out.mkdir(parents=True, exist_ok=True)
rows = [json.loads(line) for line in (root / 'output/training-prep/review.jsonl').read_text().splitlines()]
assert len({row['image_sha256'] for row in rows}) == len(rows), 'duplicate image'
assert len({row['id'] for row in rows}) == len(rows), 'duplicate ID'
rules = Path('/data1/code/molding-assist/skills/injection-parameters/references')
for name in ('output-schema.md', 'pages/injection-pages.md'):
    dest = out / Path(name).name
    if not dest.exists():
        shutil.copy2(rules / name, dest)
schema_text = (out / 'output-schema.md').read_text()
schema = json.loads(schema_text.split('```json\n', 1)[1].split('```', 1)[0])
(out / 'answer.schema.json').write_text(json.dumps(schema, ensure_ascii=False, indent=2) + '\n')

# Priority is review order only; family does not establish layout or capture group.
rows.sort(key=lambda row: (row['reserved_evaluation'], row['controller_family'] != 'TACT',
                           row['controller_family'] or '', row['id']))
cards = []
manifest = []
for row in rows:
    folder = out / row['id']
    folder.mkdir(exist_ok=True)
    image = Path(row['images'][0])
    digest = hashlib.sha256(image.read_bytes()).hexdigest()
    assert digest == row['image_sha256'], f'changed source: {image}'
    target = folder / ('image' + image.suffix.lower())
    if not target.exists():
        shutil.copy2(image, target)
    assert hashlib.sha256(target.read_bytes()).hexdigest() == digest, f'changed copy: {target}'
    links = []
    for number, source in enumerate(row['sources'], 1):
        dest = folder / f'legacy-{number}{"".join(Path(source).suffixes)}'
        if not dest.exists():
            shutil.copy2(source, dest)
        links.append(f'<a href="{row["id"]}/{dest.name}">历史标注 {number}（待核对）</a>')
    annotation = folder / 'annotation.json'
    if not annotation.exists():
        record = dict(row, image=target.name, machine_id=None, layout_id=None,
                      capture_session=None, reviewed_by=None, reviewed_at=None,
                      review_notes=[], answer=None, split=None, group_id=None,
                      status='needs_human_review')
        annotation.write_text(json.dumps(record, ensure_ascii=False, indent=2) + '\n')
    record = json.loads(annotation.read_text())
    assert record['image_sha256'] == digest, f'annotation mismatch: {annotation}'
    assert record['reserved_evaluation'] == row['reserved_evaluation'], 'evaluation flag changed'
    assert not row['reserved_evaluation'] or record['split'] in (None, 'test'), 'reserved image leaked'
    label = '评测保留：禁止训练' if row['reserved_evaluation'] else '待复核候选'
    manifest.append({'id': row['id'], 'image': str(target.relative_to(out)),
                     'annotation': str(annotation.relative_to(out)),
                     'reserved_evaluation': row['reserved_evaluation']})
    cards.append(f'<article><h2>{html.escape(row["controller_family"] or "未知")} · {row["id"]}</h2>'
                 f'<p>{label}</p><a href="{row["id"]}/annotation.json">编辑对应 annotation.json</a> · '
                 + ' · '.join(links) + f'<p><img loading="lazy" src="{target.relative_to(out)}" '
                 'alt="HMI 原图"></p></article>')
(out / 'manifest.jsonl').write_text(''.join(json.dumps(row, ensure_ascii=False) + '\n' for row in manifest))
(out / 'index.html').write_text('<!doctype html><html lang="zh-CN"><meta charset="utf-8">'
    '<title>HMI 训练标注包</title><style>body{max-width:1200px;margin:24px auto;font:16px sans-serif}'
    'img{max-width:100%}article{border-top:1px solid #aaa;padding:20px 0}a{margin-right:12px}</style>'
    '<h1>HMI 训练标注包</h1><p>先复核 TACT 6 张；控制器相同不代表布局相同。'
    '本页仅浏览，JSON 请在编辑器修改。历史答案不是金标。</p>'
    '<p><a href="output-schema.md">答案合同</a><a href="injection-pages.md">页面语义规则</a></p>'
    + '\n'.join(cards) + '</html>')
print(json.dumps({'packet': str(out), 'images': len(rows),
                  'reserved_evaluation': sum(row['reserved_evaluation'] for row in rows),
                  'note': 'Review packet only; no training samples exported.'}, ensure_ascii=False))
