// Feature 2 - Linux Gateway Communication Test (Node.js)

const http = require('http');

const LINUX_GATEWAY_HOST = '10.0.8.4';
const LINUX_GATEWAY_PORT = 18789;
const LINUX_GATEWAY_TOKEN = '21FGUgEmv3vTMlkCO811z3pwyc2kywyMQrb3YW7l_mY';

function makeRequest(path, method = 'GET', body = null) {
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

    if (body) {
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
  console.log('Feature 2 - Linux Gateway Test');
  console.log('========================================');
  console.log('');
  console.log(`Target Gateway: http://${LINUX_GATEWAY_HOST}:${LINUX_GATEWAY_PORT}`);
  console.log('');

  // Test 1: Root endpoint
  console.log('[Test 1] GET /');
  try {
    const res = await makeRequest('/');
    console.log(`  Status: ${res.statusCode}`);
    console.log(`  Response: ${res.body.substring(0, 200)}`);
  } catch (err) {
    console.log(`  FAIL: ${err.message}`);
  }
  console.log('');

  // Test 2: Health endpoint
  console.log('[Test 2] GET /health');
  try {
    const res = await makeRequest('/health');
    console.log(`  Status: ${res.statusCode}`);
    console.log(`  Response: ${res.body}`);
  } catch (err) {
    console.log(`  FAIL: ${err.message}`);
  }
  console.log('');

  // Test 3: API endpoints exploration
  const endpointsToTry = [
    '/api/status',
    '/api/gateway',
    '/api/gateways',
    '/api/messages',
    '/api/messages/incoming',
    '/messages/incoming',
    '/incoming',
  ];

  console.log('[Test 3] Exploring API endpoints...');
  for (const endpoint of endpointsToTry) {
    try {
      const res = await makeRequest(endpoint);
      console.log(`  ${endpoint}: ${res.statusCode}`);
    } catch (err) {
      console.log(`  ${endpoint}: ERROR - ${err.message}`);
    }
  }
  console.log('');

  // Test 4: Send message (try different endpoints)
  console.log('[Test 4] Send Message Test');
  const testMessage = {
    from: 'HK-vision',
    content: `Feature 2 Test - ${new Date().toISOString()}`,
    timestamp: new Date().toISOString(),
  };

  const messageEndpoints = [
    '/api/messages/incoming',
    '/messages/incoming',
    '/incoming',
    '/api/chat',
  ];

  for (const endpoint of messageEndpoints) {
    console.log(`  Trying ${endpoint}...`);
    try {
      const res = await makeRequest(endpoint, 'POST', JSON.stringify(testMessage));
      console.log(`    Status: ${res.statusCode}`);
      console.log(`    Response: ${res.body.substring(0, 200)}`);
      if (res.statusCode === 200 || res.statusCode === 201) {
        console.log('    SUCCESS!');
        break;
      }
    } catch (err) {
      console.log(`    ERROR: ${err.message}`);
    }
  }

  console.log('');
  console.log('========================================');
  console.log('Test Complete');
  console.log('========================================');
}

runTests().catch(console.error);
