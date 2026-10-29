#!/usr/bin/env node
'use strict';
const { createServer } = require('node:http');
const { WebSocketServer } = require('ws');
const { writeFileSync } = require('node:fs');
const { spawn } = require('node:child_process');
const mode = process.env.KIMI_SERVER_CASE;
const token = 'fixture-private-token';
let busy = false, peers = [], seq = 1, texts = [], prompts = 0;
const id = 'session_fixture';
const send = value => peers.forEach(peer => peer.send(JSON.stringify({ ...value, session_id: id })));
const ops = values => send({ type: 'transcript.ops', payload: { agent_id: 'main', seq: ++seq, ops: values } });
function complete() {
  if (mode === 'crash') process.exit(1);
  if (mode === 'disconnect') { peers.forEach(peer => peer.close()); return; }
  if (mode === 'hang' || mode === 'stop' || mode === 'unknown') return;
  ops([
    { op: 'step.upsert', step: { stepId: 't0.1', ordinal: 1, state: 'completed' } },
    { op: 'frame.upsert', stepId: 't0.1', frame: { frameId: 'text', kind: 'text', role: 'assistant', text: 'done:' + texts.join('|') } },
  ]);
  busy = false; send({ type: 'event.session.work_changed', payload: { busy: false, last_turn_reason: 'completed' } });
}
const server = createServer((req, res) => {
  if (req.headers.authorization !== 'Bearer ' + token) { res.writeHead(401); res.end(); return; }
  let body = ''; req.on('data', chunk => body += chunk);
  req.on('end', () => {
    const request = body ? JSON.parse(body) : {};
    const path = req.url;
    const respond = (data, code = 0) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ code, msg: code ? 'fixture rejected' : 'success', data })); };
    if (path === '/api/v1/sessions' || path === '/api/v1/sessions/' + id) return respond({ id, metadata: { cwd: process.cwd() }, busy, last_turn_reason: 'completed' });
    if (path.endsWith('/status')) return respond({ model: 'fixture', busy });
    if (path.endsWith('/config')) return respond({ default_model: 'fixture' });
    if (path.endsWith('/prompts:steer')) return respond({ steered: true });
    if (path.endsWith('/prompts') && req.method === 'GET') return respond({ active: busy ? { prompt_id: 'initial' } : null, queued: [] });
    if (path.endsWith('/prompts')) {
      prompts++;
      if (prompts > 1 && mode === 'reject') return respond(null, 40001);
      texts.push(request.content[0].text);
      if (prompts > 1 && mode === 'unknown') { req.socket.destroy(); return; }
      busy = true;
      respond({ prompt_id: request.prompt_id, status: prompts === 1 ? 'running' : 'queued' });
      if (prompts === 1) {
        ops([{ op: 'step.upsert', step: { stepId: 't0.1', ordinal: 1, state: 'running' } },
          { op: 'frame.upsert', stepId: 't0.1', frame: { frameId: 'think', kind: 'thinking', text: 'DO_NOT_DISCLOSE' } }]);
        send({ type: 'event.session.work_changed', payload: { busy: true } });
        setTimeout(complete, 300);
      }
      return;
    }
    respond(null, 40401);
  });
});
const ws = new WebSocketServer({ server });
ws.on('connection', peer => {
  peers.push(peer); peer.on('close', () => { peers = peers.filter(p => p !== peer); });
  peer.on('message', raw => {
    const frame = JSON.parse(raw);
    if (frame.type !== 'subscribe_v2') return;
    peer.send(JSON.stringify({ type: 'ack', id: frame.id, code: 0, payload: { accepted: [id] } }));
    peer.send(JSON.stringify({ type: 'transcript.reset', session_id: id, payload: { agent_id: 'main', seq: 1, snapshot: { items: [] } } }));
  });
});
server.listen(0, '127.0.0.1', () => {
  if (process.env.KIMI_SERVER_PID_FILE) {
    const descendant = spawn('/bin/sleep', ['60'], { stdio: 'ignore' });
    writeFileSync(process.env.KIMI_SERVER_PID_FILE, JSON.stringify([process.pid, descendant.pid]));
  }
  process.stdout.write(`Local: http://127.0.0.1:${server.address().port}/#token=${token}\nToken: ${token}\n`);
});
