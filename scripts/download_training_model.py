"""Download the Unsloth vision QLoRA base from ModelScope (no GPU required).

python scripts/download_training_model.py --check
python scripts/download_training_model.py
Rerun the same command to resume using the ModelScope cache.
"""
import argparse
import fcntl
import hashlib
import json
import shutil
from pathlib import Path

from modelscope import snapshot_download
from modelscope.hub.api import HubApi

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--local-dir', type=Path,
                    default=Path('/data/cache/modelscope/Qwen/Qwen3.8-27B-unsloth-bnb-4bit'))
parser.add_argument('--check', action='store_true', help='Only query the remote file manifest')
args = parser.parse_args()
model_id = 'unsloth/Qwen3.8-27B-unsloth-bnb-4bit'
# Pin the verified snapshot so retries cannot mix revisions.
revision = 'efd33fc8cf0d2973542650259250be0bf17fd3ed'
files = [f for f in HubApi().get_model_files(model_id, revision=revision, recursive=True)
         if f['Type'] == 'blob']
assert files and any(f['Path'].endswith('.safetensors') for f in files), 'No weights in repository'
for file in files:
    path = Path(file['Path'])
    if path.is_absolute() or '..' in path.parts:
        raise ValueError(f'Unsafe repository path: {path}')
total = sum(f['Size'] for f in files)
print(json.dumps({'model_id': model_id, 'revision': revision,
                  'local_dir': str(args.local_dir), 'files': len(files),
                  'total_bytes': total}, ensure_ascii=False), flush=True)
if args.check:
    raise SystemExit(0)
args.local_dir.mkdir(parents=True, exist_ok=True)
with (args.local_dir / '.download.lock').open('w') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    missing = sum(f['Size'] for f in files
                  if not (args.local_dir / f['Path']).is_file()
                  or (args.local_dir / f['Path']).stat().st_size != f['Size'])
    if shutil.disk_usage(args.local_dir).free < missing + 1024**3:
        raise OSError('Insufficient free space (including 1 GiB reserve)')
    status = args.local_dir / 'download-status.json'
    status.write_text(json.dumps({'state': 'running', 'model_id': model_id,
                                 'revision': revision}) + '\n')
    try:
        # ModelScope resumes downloads and validates remote SHA256 hashes.
        # This SDK accepts branch/tag names only; verify against the pinned manifest below.
        snapshot_download(model_id, revision='master', local_dir=str(args.local_dir),
                          max_workers=4, enable_file_lock=True)
        for file in files:
            path = args.local_dir / file['Path']
            if not path.is_file() or path.stat().st_size != file['Size']:
                raise OSError(f'Missing or incomplete file: {path}')
            digest = hashlib.sha256()
            with path.open('rb') as source:
                for chunk in iter(lambda: source.read(1024 * 1024), b''):
                    digest.update(chunk)
            if digest.hexdigest() != file['Sha256']:
                raise OSError(f'Checksum differs from pinned revision: {path}')
        state = {'state': 'complete', 'model_id': model_id, 'revision': revision,
                 'total_bytes': total}
    except Exception as exc:
        status.write_text(json.dumps({'state': 'failed', 'error': str(exc)}) + '\n')
        raise
    status.write_text(json.dumps(state) + '\n')
    print(json.dumps(state), flush=True)
