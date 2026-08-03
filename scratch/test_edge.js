const http = require('http');

async function testPort(port, fileId) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const req = http.get(`http://127.0.0.1:${port}/edge/file/${fileId}`, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        const t1 = Date.now();
        console.log(`Port ${port} -> Status: ${res.statusCode}, Latency: ${t1 - t0}ms, CacheStatus: ${res.headers['x-cache-status']}, Body: ${body.slice(0, 50)}`);
        resolve();
      });
    });
    req.on('error', (err) => {
      console.log(`Port ${port} -> ERROR: ${err.message}`);
      resolve();
    });
    req.setTimeout(2000, () => {
      console.log(`Port ${port} -> TIMEOUT 2000ms`);
      req.destroy();
      resolve();
    });
  });
}

async function run() {
  console.log('Testing Edge Ports 3001, 3002, 3003 directly:');
  await testPort(3001, 481);
  await testPort(3002, 481);
  await testPort(3003, 481);
}

run();
