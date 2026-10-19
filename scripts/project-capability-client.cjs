#!/usr/bin/env node
const http = require('node:http');
const [operation, source, value, field, ordinal] = process.argv.slice(2);
function invoke(access, request) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(request);
    const req = http.request({ socketPath: access.socket, path: '/', method: 'POST', headers: {
      Authorization: 'Bearer ' + access.token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
    }, timeout: 35000 }, response => {
      let text = ''; response.on('data', chunk => { text += chunk; if (text.length > 3 * 1024 * 1024) req.destroy(new Error('response too large')); });
      response.on('end', () => { try { const result = JSON.parse(text); response.statusCode === 200 ? resolve(result) : reject(new Error(result.error || 'capability request refused')); } catch (error) { reject(error); } });
    });
    req.on('timeout', () => req.destroy(new Error('project capability request timed out'))); req.on('error', reject); req.end(body);
  });
}
(async () => {
  const projects = process.env.AP_PROJECT_CAPABILITIES_JSON ? JSON.parse(process.env.AP_PROJECT_CAPABILITIES_JSON) : null;
  if (operation === 'sources' && projects) {
    const results = await Promise.all(projects.map(async project => ({ project, result: await invoke(project, { operation }) })));
    return { sources: results.flatMap(({ project, result }) => result.sources.map(item => ({ ...item, key: project.key + '/' + item.key }))),
      localReadOnlyRoots: results.flatMap(({ result }) => result.localReadOnlyRoots) };
  }
  let selected = { socket: process.env.AP_PROJECT_CAPABILITY_SOCKET, token: process.env.AP_PROJECT_CAPABILITY_TOKEN }, alias = source;
  if (projects) {
    const slash = (source || '').indexOf('/');
    selected = projects.find(project => project.key === source.slice(0, slash));
    if (!selected || slash < 1) throw new Error('Use the qualified project/source alias returned by sources');
    alias = source.slice(slash + 1);
  }
  const request = operation === 'query' ? { operation, source: alias, query: value, ...(field ? { cursor: field } : {}) }
    : operation === 'image' ? { operation, source: alias, recordId: value, field, index: Number(ordinal || '0') } : { operation };
  return invoke(selected, request);
})().then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(error => {
  process.stdout.write(JSON.stringify({ error: error.message }) + '\n'); process.exitCode = 1;
});
