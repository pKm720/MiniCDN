const http = require('http');

async function checkPort(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        console.log(`Port ${port} -> Status: ${res.statusCode}, Body: ${body}`);
        resolve();
      });
    });
    req.on('error', (err) => {
      console.log(`Port ${port} -> ERROR: ${err.message}`);
      resolve();
    });
    req.setTimeout(1000, () => {
      console.log(`Port ${port} -> TIMEOUT`);
      req.destroy();
      resolve();
    });
  });
}

async function run() {
  await checkPort(3000);
  await checkPort(3001);
  await checkPort(3002);
  await checkPort(3003);
  await checkPort(4000);
}

run();
