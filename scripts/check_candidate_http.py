"""Exercise an ISOLATED lab backed by a real Reader; creates disposable batches.

Run against a temporary lab data directory, never a user's existing lab.
This checks transport/persistence, not recognition accuracy. No Trial calls.
"""
import argparse
import copy
import hashlib
import json
from pathlib import Path
import time

import httpx


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--lab-url', required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('images', type=Path, nargs='+')
    args = parser.parse_args()
    results = []
    with httpx.Client(base_url=args.lab_url, timeout=240, trust_env=False) as client:
        for image in args.images:
            response = client.post('/api/sessions')
            response.raise_for_status()
            sid = response.json()['session']['id']
            start = time.monotonic()
            response = client.post(f'/api/sessions/{sid}/images',
                                   files={'file': (image.name, image.read_bytes())})
            response.raise_for_status()
            body = response.json()
            entry = {'image': str(image), 'sha256': hashlib.sha256(image.read_bytes()).hexdigest(),
                     'seconds': round(time.monotonic() - start, 2), 'checks_passed': False,
                     'attempts': body['session']['images'][0]['attempts']}
            results.append(entry)
            # Keep real failures and original model output even if a check raises.
            args.output.write_text(json.dumps(results, ensure_ascii=False, indent=2))
            assert body['candidates'], 'No candidates; inspect saved attempts'
            candidate = body['candidates'][0]
            raw = copy.deepcopy(candidate['result'])
            review = copy.deepcopy(raw)
            items = [item for section in review['sections'] for field in section['fields']
                     for item in field['items']]
            assert items and all(item.get('needs_confirmation') is True for item in items)
            items[0]['value'] = 123.456
            payload = {'expected_revision': body['session']['revision'], 'drafts': {
                candidate['image_id']: {'attempt': candidate['attempt'],
                                       'result': review, 'confirmed': False}}}
            response = client.put(f'/api/sessions/{sid}/review', json=payload)
            response.raise_for_status()
            assert client.put(f'/api/sessions/{sid}/review', json=payload).status_code == 409
            for suffix in ('', '/export'):
                response = client.get(f'/api/sessions/{sid}' + suffix)
                response.raise_for_status()
                restored = response.json()['candidates'][0]
                assert restored['result'] == raw
                assert restored['review']['result'] == review
                assert restored['review']['confirmed'] is False
                assert restored['review']['attempt'] == candidate['attempt']
            entry['checks_passed'] = True
            args.output.write_text(json.dumps(results, ensure_ascii=False, indent=2))
            print(f'PASS {image}: {len(items)} candidates, {entry["seconds"]}s', flush=True)
