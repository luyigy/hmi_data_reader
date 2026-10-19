#!/usr/bin/env node
const http = require('node:http');
const [operation, source, value, field, ordinal] = process.argv.slice(2);
const request = operation === 'query' ? { operation, source, query: value, ...(field ? { cursor: field } : {}) } : operation === 'image' ? { operation, source, recordId: value, field, index: Number(ordinal || '0') } : { operation };
const body = JSON.stringify(request);
const req = http.request({ socketPath: process.env.AP_PROJECT_CAPABILITY_SOCKET, path: '/', method: 'POST', headers: {
  Authorization: 'Bearer ' + process.env.AP_PROJECT_CAPABILITY_TOKEN, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
}, timeout: 35000 }, response => {
  let text = ''; response.on('data', chunk => { text += chunk; if (text.length > 3 * 1024 * 1024) req.destroy(new Error('response too large')); });
  response.on('end', () => { process.stdout.write(text + '\n'); if (response.statusCode !== 200) process.exitCode = 1; });
});
req.on('timeout', () => req.destroy(new Error('project capability request timed out')));
req.on('error', error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
req.end(body);
