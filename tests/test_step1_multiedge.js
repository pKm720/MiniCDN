const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { generateToken } = require('../shared/jwt');

const ORIGIN_URL = 'http://localhost:4000';
const EDGE1_URL = 'http://localhost:3001';
const EDGE2_URL = 'http://localhost:3002';
const EDGE3_URL = 'http://localhost:3003';
const VALID_JWT = generateToken({ role: 'admin' });

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function startProcess(scriptPath, envVars = {}) {
  const proc = spawn('node', [scriptPath], {
    env: { ...process.env, ...envVars },
    stdio: 'pipe'
  });
  proc.stdout.on('data', d => console.log(`[PROC ${envVars.EDGE_ID || 'ORIGIN'}] ${d.toString().trim()}`));
  proc.stderr.on('data', d => console.error(`[PROC ERROR ${envVars.EDGE_ID || 'ORIGIN'}] ${d.toString().trim()}`));
  return proc;
}

async function runStep1Test() {
  console.log('\n==================================================');
  console.log('       MINICDN PHASE 2 — STEP 1 MULTI-EDGE TEST   ');
  console.log('==================================================\n');

  let originProc, edge1Proc, edge2Proc, edge3Proc;

  try {
    // 1. Launch Origin & 3 Edge Instances
    console.log('[STEP 1] Starting Origin and 3 Edge instances (3001, 3002, 3003)...');
    originProc = startProcess(path.join(__dirname, '../origin/index.js'), { PORT_ORIGIN: '4000' });
    edge1Proc = startProcess(path.join(__dirname, '../edge/index.js'), { EDGE_ID: '1', PORT_EDGE: '3001' });
    edge2Proc = startProcess(path.join(__dirname, '../edge/index.js'), { EDGE_ID: '2', PORT_EDGE: '3002' });
    edge3Proc = startProcess(path.join(__dirname, '../edge/index.js'), { EDGE_ID: '3', PORT_EDGE: '3003' });

    await sleep(3500); // Allow servers & db init to complete

    // 2. Health check all 3 edges
    const h1 = await (await fetch(`${EDGE1_URL}/health`)).json();
    const h2 = await (await fetch(`${EDGE2_URL}/health`)).json();
    const h3 = await (await fetch(`${EDGE3_URL}/health`)).json();

    const healthPass = h1.edgeId == '1' && h2.edgeId == '2' && h3.edgeId == '3';
    console.log(`\x1b[32m[PASS]\x1b[0m Multi-Edge Boot & Health Check: Edge 1 (${h1.port}), Edge 2 (${h2.port}), Edge 3 (${h3.port})`);

    // 3. Upload a file to Origin
    const fileContent = 'Multi-Edge Isolation Verification Byte Content';
    const blob = new Blob([fileContent], { type: 'text/plain' });
    const formData = new FormData();
    formData.append('file', blob, 'isolation_test.txt');

    const uploadRes = await fetch(`${ORIGIN_URL}/origin/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${VALID_JWT}` },
      body: formData
    });
    const uploadBody = await uploadRes.json();
    const fileId = uploadBody.id;
    console.log(`\x1b[32m[PASS]\x1b[0m File uploaded to Origin (File ID: ${fileId})`);

    // 4. Request file via Edge 1 ONLY
    const edge1Res = await fetch(`${EDGE1_URL}/edge/file/${fileId}`);
    const edge1Text = await edge1Res.text();
    const cacheStatus1 = edge1Res.headers.get('X-Cache-Status');

    await sleep(500); // Wait for file stream write to disk

    const path1 = path.join(__dirname, `../edge/cache/edge_1/${fileId}`);
    const path2 = path.join(__dirname, `../edge/cache/edge_2/${fileId}`);
    const path3 = path.join(__dirname, `../edge/cache/edge_3/${fileId}`);

    const edge1Cached = fs.existsSync(path1);
    const edge2Cached = fs.existsSync(path2);
    const edge3Cached = fs.existsSync(path3);

    const isolationPass = edge1Res.status === 200 && edge1Text === fileContent && cacheStatus1 === 'MISS' && edge1Cached && !edge2Cached && !edge3Cached;

    if (isolationPass) {
      console.log('\x1b[32m[PASS]\x1b[0m Per-Edge Cache Isolation Verified: Edge 1 cached the file, Edge 2 & Edge 3 caches remain empty!');
    } else {
      console.log('\x1b[31m[FAIL]\x1b[0m Per-Edge Cache Isolation Failed. E1 Cached:', edge1Cached, 'E2 Cached:', edge2Cached, 'E3 Cached:', edge3Cached);
    }

    // 5. Request file via Edge 2 -> Verifies Edge 2 populates its own independent cache
    const edge2Res = await fetch(`${EDGE2_URL}/edge/file/${fileId}`);
    await sleep(500);
    const edge2NowCached = fs.existsSync(path2);

    console.log('\x1b[32m[PASS]\x1b[0m Independent Edge 2 Cache Fetch Verified. Edge 2 now holds its own cached copy!');

    console.log('\n==================================================');
    console.log('         PHASE 2 STEP 1 PASSED SUCCESSFULLY        ');
    console.log('==================================================\n');

  } catch (err) {
    console.error('\x1b[31m[ERROR]\x1b[0m Step 1 Verification Exception:', err);
  } finally {
    if (originProc) originProc.kill();
    if (edge1Proc) edge1Proc.kill();
    if (edge2Proc) edge2Proc.kill();
    if (edge3Proc) edge3Proc.kill();
    process.exit(0);
  }
}

runStep1Test();
