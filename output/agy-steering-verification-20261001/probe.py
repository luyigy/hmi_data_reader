import json, os, pathlib, select, subprocess, sys, tempfile, time

mode = sys.argv[1]
assert mode in ('control', 'headless', 'interactive')
root = pathlib.Path(__file__).resolve().parent
work = pathlib.Path(tempfile.mkdtemp(prefix='agy-boundary-'))
(work / 'wait.py').write_text("from pathlib import Path\nimport time\nPath('started').write_text(str(time.time()))\ntime.sleep(20)\nPath('finished').write_text(str(time.time()))\n")
prompt = ('Remember BLUE731. This is a harmless CLI boundary experiment. '
          'First run python3 wait.py in the current directory and wait for it to finish. '
          'Only afterwards, in a SEPARATE tool call, run: touch obsolete . '
          'Then reply OLD_DONE BLUE731. Do not use other tools or edit anything else.')
correction = 'Cancel the remaining original instructions. Do NOT create obsolete. Reply only NEW_DONE and the code I asked you to remember. No more tools.'
args = ['agy', '--new-project', '--dangerously-skip-permissions']
if mode == 'interactive':
    import pexpect
    args += ['--prompt-interactive', prompt]
    proc = pexpect.spawn(args[0], args[1:], cwd=str(work), env={**os.environ, 'TERM':'xterm-256color'}, dimensions=(40,160), encoding=None)
    fd = proc.child_fd
else:
    args += ['--input-format','stream-json','--output-format','stream-json']
    err = (root / (mode+'.stderr')).open('wb')
    proc = subprocess.Popen(args, cwd=work, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=err)
    fd = proc.stdout.fileno()
t0 = time.monotonic()
log = (root / (mode+'.timeline.jsonl')).open('w')
raw = (root / (mode+'.raw')).open('wb')
def record(kind, **data):
    event = dict(t=round(time.monotonic()-t0,3), kind=kind, **data)
    log.write(json.dumps(event)+'\n'); log.flush()
    print(json.dumps(event), flush=True)
def send(text):
    if mode == 'interactive':
        proc.send(text.encode()); time.sleep(.15); proc.send(b'\r')
    else:
        proc.stdin.write((json.dumps({'event':'user','message':{'content':text}})+'\n').encode()); proc.stdin.flush()
    record('send', text=text)
record('start', args=args, cwd=str(work), pid=proc.pid, prompt=prompt)
if mode != 'interactive': send(prompt)
seen=set(); sent=False; results=[]; buffer=b''; completed_at=None
try:
    while time.monotonic()-t0 < 150:
        if completed_at and time.monotonic()-completed_at>30: break
        for name in ('started','finished','obsolete'):
            if name not in seen and (work/name).exists():
                seen.add(name); record('file', name=name)
        if 'started' in seen and mode != 'control' and not sent:
            send(correction); sent=True
        ready,_,_ = select.select([fd],[],[],.1)
        if ready:
            try: chunk=os.read(fd,65536)
            except OSError: break
            if not chunk: break
            raw.write(chunk); raw.flush()
            if mode == 'interactive':
                record('terminal', text=chunk.decode(errors='replace'))
                if 'finished' in seen and completed_at is None: completed_at=time.monotonic()
                if completed_at and time.monotonic()-completed_at>30: break
            else:
                buffer+=chunk
                while b'\n' in buffer:
                    line,buffer=buffer.split(b'\n',1)
                    try: event=json.loads(line)
                    except ValueError: record('diagnostic',text=line.decode(errors='replace')); continue
                    record('event',data=event)
                    if event.get('event')=='result': results.append(event['result'])
                if len(results)>=(1 if mode=='control' else 2): break
    record('summary', files=sorted(seen), sent=sent, results=results)
finally:
    if mode=='interactive': proc.close(force=True)
    else:
        proc.stdin.close()
        try: proc.wait(timeout=5)
        except subprocess.TimeoutExpired: proc.terminate(); proc.wait(timeout=5)
    raw.close(); log.close()
