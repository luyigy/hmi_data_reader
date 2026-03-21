// Feature 2 - Linux Gateway API Discovery

const http = require('http');

const LINUX_GATEWAY_HOST = '10.0.8.4';
const LINUX_GATEWAY_PORT = 18789;
const LINUX_GATEWAY_TOKEN = '21FGUgEmv3vTMlkCO811z3pwyc2kywyMQrb3YW7l_mY';

function makeRequest(path, method = 'GET', body = null, useAuth = false) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: LINUX_GATEWAY_HOST,
      port: LINUX_GATEWAY_PORT,
      path: path,
      method: method,
      headers: {
        'Content-Type': 'application/json',
      },
      timeout: 5000,
    };

    if (useAuth && body) {
      options.headers['Authorization'] = `Bearer ${LINUX_GATEWAY_TOKEN}`;
      options.headers['Content-Length'] = Buffer.byteLength(body);
    }

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data,
        });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    if (body) {
      req.write(body);
    }
    req.end();
  });
}

async function runTests() {
  console.log('========================================');
  console.log('Feature 2 - Linux Gateway API Discovery');
  console.log('========================================');
  console.log('');

  // Test 1: GET /messages/incoming (check what it returns)
  console.log('[Test 1] GET /messages/incoming');
  try {
    const res = await makeRequest('/messages/incoming');
    console.log(`  Status: ${res.statusCode}`);
    console.log(`  Content-Type: ${res.headers['content-type']}`);
    console.log(`  Response: ${res.body.substring(0, 500)}`);
  } catch (err) {
    console.log(`  FAIL: ${err.message}`);
  }
  console.log('');

  // Test 2: GET /incoming
  console.log('[Test 2] GET /incoming');
  try {
    const res = await makeRequest('/incoming');
    console.log(`  Status: ${res.statusCode}`);
    console.log(`  Content-Type: ${res.headers['content-type']}`);
    console.log(`  Response: ${res.body.substring(0, 500)}`);
  } catch (err) {
    console.log(`  FAIL: ${err.message}`);
  }
  console.log('');

  // Test 3: POST /messages/incoming with auth
  console.log('[Test 3] POST /messages/incoming (with auth)');
  try {
    const testMessage = {
      from: 'HK-vision',
      content: `Feature 2 Test - ${new Date().toISOString()}`,
    };
    const res = await makeRequest('/messages/incoming', 'POST', JSON.stringify(testMessage), true);
    console.log(`  Status: ${res.statusCode}`);
    console.log(`  Response: ${res.body.substring(0, 500)}`);
  } catch (err) {
    console.log(`  FAIL: ${err.message}`);
  }
  console.log('');

  // Test 4: POST /incoming with auth
  console.log('[Test 4] POST /incoming (with auth)');
  try {
    const testMessage = {
      from: 'HK-vision',
      content: `Feature 2 Test - ${new Date().toISOString()}`,
    };
    const res = await makeRequest('/incoming', 'POST', JSON.stringify(testMessage), true);
    console.log(`  Status: ${res.statusCode}`);
    console.log(`  Response: ${res.body.substring(0, 500)}`);
  } catch (err) {
    console.log(`  FAIL: ${err.message}`);
  }
  console.log('');

  // Test 5: Try Feishu-related endpoints
  console.log('[Test 5] Exploring Feishu endpoints...');
  const feishuEndpoints = [
    '/api/feishu',
    '/feishu',
    '/api/bot',
    '/bot',
    '/api/webhook',
    '/webhook',
  ];
  for (const endpoint of feishuEndpoints) {
    try {
      const res = await makeRequest(endpoint);
      console.log(`  ${endpoint}: ${res.statusCode}`);
    } catch (err) {
      console.log(`  ${endpoint}: ERROR`);
    }
  }
  console.log('');

  // Test 6: Check if there's an API documentation endpoint
  console.log('[Test 6] Checking for API docs...');
  const docEndpoints = ['/api', '/api/', '/docs', '/swagger', '/openapi'];
  for (const endpoint of docEndpoints) {
    try {
      const res = await makeRequest(endpoint);
      console.log(`  ${endpoint}: ${res.statusCode} - ${res.body.substring(0, 100)}`);
    } catch (err) {
      console.log(`  ${endpoint}: ERROR`);
    }
  }

  console.log('');
  console.log('========================================');
  console.log('Discovery Complete');
  console.log('========================================');
}

runTests().catch(console.error);
