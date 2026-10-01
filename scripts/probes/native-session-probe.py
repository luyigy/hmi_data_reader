#!/usr/bin/env python3
"""S01 observational probe; never attaches an existing user session.

python3 scripts/probes/native-session-probe.py agy turns --model <agy-model>
python3 scripts/probes/native-session-probe.py pi turns --model <provider/model>
Raw evidence is private under a new /tmp/ap-native-* directory; review before sharing.
TUI timing is an experiment, never a production completion detector.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import pty
import selectors
import signal
import struct
import subprocess
import tempfile
import termios
import time
import fcntl


def agy_args(case, root, model, source, effort):
    args = ['agy', '--log-file', str(root / 'agy.log')]
    args += ['--conversation', source] if source else ['--new-project']
    if model:
        args += ['--model', model, '--effort', effort]
    if case in ('tui', 'hybrid', 'tui-json', 'hooks', 'hooks-permission'):
        prompt = ('Use run_command to execute exactly: printf S01_PERMISSION. Do not bypass permission.'
                  if case == 'hooks-permission' else 'Without tools, reply exactly NATIVE_READY.')
        args += ['--prompt-interactive', prompt]
    if case == 'tui-json':
        args += ['--output-format', 'stream-json']
    elif case not in ('tui', 'hooks', 'hooks-permission'):
        args += ['--input-format', 'stream-json', '--output-format', 'stream-json']
    return args


def pi_args(case, root, model, source, effort):
    args = ['pi', '--no-extensions', '--no-skills', '--no-prompt-templates',
            '--no-themes', '--no-context-files', '--no-tools',
            '--session-dir', str(root / 'sessions')]
    if source:
        args += ['--session', source]
    if case == 'tools':
        args += ['--tools', 'read']
    if model:
        args += ['--model', model, '--thinking', effort]
    if case != 'tui':
        args += ['--mode', 'rpc']
    else:
        args += ['Without tools, reply exactly NATIVE_READY.']
    return args


def message(harness, text):
    return ({'event': 'user', 'message': {'content': text}} if harness == 'agy'
            else {'type': 'prompt', 'message': text})


def complete(harness, event):
    return (event.get('event') == 'result' if harness == 'agy'
            else event.get('type') == 'agent_end')


def active(harness, event):
    return (event.get('event') == 'step_update'
            and event.get('step_update', {}).get('state') == 'ACTIVE'
            if harness == 'agy' else event.get('type') == 'message_update')


def kill_owned_group(proc, sig):
    # start_new_session gives this probe ownership of exactly this process group.
    try:
        os.killpg(proc.pid, sig)
    except ProcessLookupError:
        pass


def config_hashes():
    paths = [Path.home() / '.gemini/config/config.json',
             Path.home() / '.gemini/antigravity-cli/settings.json',
             Path.home() / '.pi/agent/settings.json']
    return {str(p): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in paths if p.exists()}


def run(options):
    root = Path(tempfile.mkdtemp(prefix='ap-native-'))
    work = root / 'workspace'
    work.mkdir()
    (work / 'fixture.txt').write_text('S01 read-only fixture\n')
    source = None
    if options.resume_from:
        evidence = json.loads(Path(options.resume_from).read_text())
        if evidence['harness'] != options.harness:
            raise ValueError('Resume evidence belongs to a different harness')
        work = Path(evidence['root']) / 'workspace'
        if options.harness == 'agy':
            source = next(e['data']['conversation_id'] for e in evidence['events']
                          if e['data'].get('event') == 'init')
        else:
            source = next(str(p) for p in Path(evidence['root']).glob('sessions/*.jsonl'))
    elif options.case == 'resume':
        raise ValueError('resume requires --resume-from <own probe report.json>')
    args = (agy_args if options.harness == 'agy' else pi_args)(
        options.case, root, options.model, source, options.effort)
    if options.case == 'no-auth':
        # Hide credentials only in the child's mount namespace; never log out the user.
        args = ['/usr/bin/bwrap', '--die-with-parent', '--ro-bind', '/', '/',
                '--bind', str(root), str(root), '--tmpfs', str(Path.home() / '.gemini'),
                '--', *args]
    terminal = options.case in ('tui', 'hybrid', 'tui-json', 'hooks', 'hooks-permission')
    if options.case.startswith('hooks'):
        hook = root / 'record_hook.py'
        hook.write_text(
            'import json,sys,time\nfrom pathlib import Path\n'
            'data=json.load(sys.stdin)\n'
            'with open(sys.argv[1], "a") as f:\n'
            ' f.write(json.dumps(dict(event=sys.argv[2], at=time.time(), data=data))+"\\n")\n'
            'print(json.dumps({"decision":"force_ask"} if sys.argv[2]=="PreToolUse" '
            'else {"decision":"stop"} if sys.argv[2]=="Stop" else {}))\n')
        (work / '.agents').mkdir()
        hooks = {event: [{'type': 'command', 'timeout': 5,
                          'command': f'python3 {hook} {root / "hooks.jsonl"} {event}'}]
                 for event in ('PreInvocation', 'PostInvocation', 'Stop')}
        if options.case == 'hooks-permission':
            hooks['PreToolUse'] = [{'matcher': 'run_command', 'hooks': [
                {'command': f'python3 {hook} {root / "hooks.jsonl"} PreToolUse', 'timeout': 5}]}]
        (work / '.agents/hooks.json').write_text(json.dumps({'s01-observe': hooks}))
    master = slave = None
    if terminal:
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 32, 120, 0, 0))
    before = config_hashes()
    started = time.monotonic()
    env = dict(os.environ, TERM='xterm-256color', NO_COLOR='1')
    proc = subprocess.Popen(args, cwd=work, env=env, start_new_session=True,
                            stdin=slave if terminal else subprocess.PIPE,
                            stdout=slave if terminal else subprocess.PIPE,
                            stderr=slave if terminal else subprocess.PIPE)
    if slave is not None:
        os.close(slave)
    report = dict(harness=options.harness, case=options.case, root=str(root),
                  command=args, cwd=str(work), pid=proc.pid, events=[], inputs=[], reason='exit')
    print(str(root / 'report.json'), flush=True)
    selector = selectors.DefaultSelector()
    streams = {'terminal': master} if terminal else {
        'stdout': proc.stdout.fileno(), 'stderr': proc.stderr.fileno()}
    buffers = {name: b'' for name in streams}
    raw = {name: open(root / (name + '.log'), 'wb') for name in streams}
    for name, fd in streams.items():
        selector.register(fd, selectors.EVENT_READ, name)

    def send(value):
        payload = value if isinstance(value, str) else json.dumps(value) + '\n'
        report['inputs'].append(dict(at=round(time.monotonic() - started, 3), data=value))
        if terminal:
            os.write(master, payload.encode())
        else:
            proc.stdin.write(payload.encode())
            proc.stdin.flush()

    first = 'Without tools, remember the word COBALT. Reply exactly COBALT.'
    if options.case in ('queue', 'interrupt'):
        first = 'Without tools, write the numbers 1 through 180 in words, one per line.'
    elif options.case == 'tools':
        first = ('Read fixture.txt twice using two separate calls to the same file-reading tool. '
                 'Do not write files, run commands or delegate. Reply READ_TWICE.')
    elif options.case == 'permission':
        first = ('Use run_command to execute exactly: printf S01_PERMISSION. '
                 'Request permission if required; do not bypass it. Do not write files.')
    elif options.case == 'resume':
        first = 'Without tools, what word did I ask you to remember? Reply only that word.'
    done = 0
    triggered = False
    finish_at = None
    timed_actions = [(12, '/model\r'), (18, '\x1b'), (22, '/effort\r'),
                     (28, '\x1b'), (32, 'Without tools, count from 1 to 180 in words.\r'),
                     (36, '\x1b'), (40, '/exit\r')]
    if options.case == 'hooks':
        timed_actions = [(15, 'Without tools, reply exactly SECOND_TURN.\r'),
                         (28, 'Without tools, count from 1 to 180 in words.\r'),
                         (36, '\x1b'), (42, 'Without tools, reply exactly AFTER_CANCEL.\r'),
                         (54, '/exit\r')]
    elif options.case == 'hooks-permission':
        timed_actions = [(25, '\x1b'), (32, '/exit\r')]
    try:
        if not terminal:
            if options.case == 'invalid':
                send('{broken-json\n')
            elif options.case == 'control':
                send({'event': 'control_request', 'request': {'subtype': 'interrupt'}}
                     if options.harness == 'agy' else {'type': 'not_a_command', 'id': 'bad'})
            elif options.case == 'slash':
                send(message(options.harness, '/model'))
            else:
                if options.harness == 'pi':
                    send({'type': 'get_state', 'id': 'before'})
                send(message(options.harness, first))
        elif options.case == 'hybrid':
            timed_actions = [(3, json.dumps(message(options.harness, first)) + '\n')]
        while selector.get_map():
            elapsed = time.monotonic() - started
            if elapsed > options.seconds:
                report['reason'] = 'total_timeout'
                break
            if finish_at and elapsed >= finish_at:
                report['reason'] = 'observation_complete'
                break
            if terminal and timed_actions and elapsed >= timed_actions[0][0]:
                send(timed_actions.pop(0)[1])
            for key, _ in selector.select(0.1):
                name = key.data
                try:
                    chunk = os.read(key.fd, 65536)
                except OSError:
                    chunk = b''  # Linux PTY returns EIO when its slave closes.
                if not chunk:
                    selector.unregister(key.fd)
                    continue
                raw[name].write(chunk)
                raw[name].flush()
                if terminal and b'\x1b[6n' in chunk:
                    os.write(master, b'\x1b[1;1R')  # terminal cursor query, not agent input
                buffers[name] += chunk
                while b'\n' in buffers[name]:
                    line, buffers[name] = buffers[name].split(b'\n', 1)
                    try:
                        event = json.loads(line)
                    except (ValueError, UnicodeDecodeError):
                        continue
                    if not isinstance(event, dict) or name == 'stderr':
                        continue
                    report['events'].append(dict(at=round(elapsed, 3), data=event))
                    if not triggered and options.case in ('queue', 'interrupt') and active(options.harness, event):
                        triggered = True
                        if options.case == 'queue':
                            value = message(options.harness, 'Without tools, reply exactly QUEUED_SECOND.')
                            if options.harness == 'pi':
                                value['streamingBehavior'] = 'followUp'
                            send(value)
                        elif options.harness == 'pi':
                            send({'type': 'abort', 'id': 'stop'})
                            finish_at = elapsed + 5
                        else:
                            kill_owned_group(proc, signal.SIGTERM)
                    if complete(options.harness, event):
                        done += 1
                        if options.case == 'turns' and done == 1:
                            send(message(options.harness, 'Without tools, repeat the remembered word.'))
                        elif options.case != 'queue' or options.harness == 'pi' or done >= 2:
                            if not terminal and not proc.stdin.closed:
                                if options.harness == 'pi':
                                    send({'type': 'get_state', 'id': 'after'})
                                proc.stdin.close()
                            finish_at = elapsed + 3
    finally:
        report['alive_before_cleanup'] = proc.poll() is None
        kill_owned_group(proc, signal.SIGTERM)
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            pass
        kill_owned_group(proc, signal.SIGKILL)
        proc.wait(timeout=2)
        selector.close()
        for stream in raw.values():
            stream.close()
        if master is not None:
            os.close(master)
        for stream in (proc.stdin, proc.stdout, proc.stderr):
            if stream and not stream.closed:
                stream.close()
        report.update(exit_code=proc.returncode, completions=done,
                      elapsed=round(time.monotonic() - started, 3),
                      global_settings_unchanged=before == config_hashes())
        if (root / 'hooks.jsonl').exists():
            report['hooks'] = [json.loads(line) for line in (root / 'hooks.jsonl').read_text().splitlines()]
        (root / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
        print(json.dumps({k: v for k, v in report.items() if k not in ('events', 'inputs', 'command', 'hooks')}, ensure_ascii=False))
    if options.case == 'turns':
        verify_turns(report)


def verify_turns(report):
    """A real CLI check: two prompts, two successful completions, retained context."""
    assert report['exit_code'] == 0 and report['completions'] == 2, 'two-turn lifecycle failed'
    events = [e['data'] for e in report['events'] if complete(report['harness'], e['data'])]
    if report['harness'] == 'agy':
        assert len({e['result']['conversation_id'] for e in events}) == 1
        assert all(e['result']['status'] == 'SUCCESS' for e in events)
        replies = [e['result']['response'] for e in events]
    else:
        assert all(e['messages'][-1]['stopReason'] == 'stop' for e in events)
        replies = [''.join(c.get('text', '') for c in e['messages'][-1]['content']) for e in events]
    assert all('COBALT' in reply for reply in replies), 'conversation context was not retained'
    print('two-turn assertions passed')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('harness', choices=['agy', 'pi'])
    parser.add_argument('case', choices=['turns', 'queue', 'interrupt', 'tools', 'resume',
                                        'invalid', 'control', 'slash', 'tui', 'hybrid',
                                        'tui-json', 'permission', 'hooks', 'hooks-permission', 'no-auth'])
    parser.add_argument('--model')
    parser.add_argument('--effort', default='low')
    parser.add_argument('--resume-from')
    parser.add_argument('--seconds', type=int, default=90)
    options = parser.parse_args()
    if not 1 <= options.seconds <= 300:
        parser.error('--seconds must be between 1 and 300')
    if options.harness == 'pi' and options.case in ('hybrid', 'tui-json', 'permission', 'hooks', 'hooks-permission', 'no-auth'):
        parser.error('this case tests an agy-specific interface')
    run(options)
