const fs = require('fs');
const path = require('path');
const http = require('http');
const db = require('./db');
const redis = require('./redis');
const logger = require('./logger');
const cluster = require('./cluster');

const ORIGIN_STORAGE_DIR = path.join(__dirname, '../origin/storage');

async function triggerReplication(fileId, targetEdges = [1, 2, 3]) {
  const fId = String(fileId);
  const threshold = parseInt(process.env.REPLICATION_THRESHOLD || '20', 10);
  const count = await redis.getDownloadCount(fId);

  if (count < threshold) {
    return { replicated: false, reason: 'below_threshold', count, threshold };
  }

  const isReplicated = await redis.getReplicatedFlag(fId);
  if (isReplicated) {
    return { replicated: false, reason: 'already_replicated', replicatedAt: isReplicated };
  }

  const existingEdgeStrings = await redis.getEdgesForFile(fId);
  const existingEdgeIds = existingEdgeStrings.map(id => parseInt(id, 10));
  const missingEdges = targetEdges.filter(id => !existingEdgeIds.includes(id));

  if (missingEdges.length === 0) {
    await redis.setReplicatedFlag(fId, Date.now());
    logger.info({ fileId: fId }, 'Proactive replication skipped — file already present on all target edges');
    return { replicated: true, reason: 'already_on_all_edges' };
  }

  // Find origin storage file
  const dbRes = await db.query('SELECT filename FROM files WHERE id = $1', [parseInt(fId, 10)]);
  if (!dbRes.rows[0]) {
    logger.warn({ fileId: fId }, 'Cannot replicate — file record not found in database');
    return { replicated: false, reason: 'file_not_found_in_db' };
  }

  const filename = dbRes.rows[0].filename;
  // Files in Origin storage are stored by numeric ID, not original filename
  const localStoragePath = path.join(ORIGIN_STORAGE_DIR, fId);
  if (!fs.existsSync(localStoragePath)) {
    logger.warn({ fileId: fId, filename }, 'Cannot replicate — file missing from origin storage disk');
    return { replicated: false, reason: 'file_missing_from_disk' };
  }

  logger.info({ fileId: fId, count, threshold, missingEdges }, 'Replication threshold crossed! Proactively pushing file to missing edges...');

  const pushedTo = [];
  const failedEdges = [];

  for (const edgeId of missingEdges) {
    const target = cluster.getEdgeTarget(edgeId);
    const pushed = await pushFileToEdge(edgeId, target.hostname, target.port, fId, localStoragePath);
    if (pushed) {
      pushedTo.push(edgeId);
      await redis.addFileToEdge(fId, edgeId);
    } else {
      failedEdges.push(edgeId);
    }
  }

  if (pushedTo.length > 0) {
    await redis.setReplicatedFlag(fId, Date.now());
  }

  return { replicated: true, pushedTo, failedEdges };
}

function pushFileToEdge(edgeId, edgeHost, edgePort, fileId, filePath) {
  return new Promise((resolve) => {
    const fileStream = fs.createReadStream(filePath);
    const stats = fs.statSync(filePath);

    const req = http.request({
      hostname: edgeHost,
      port: edgePort,
      path: '/edge/receive',
      method: 'POST',
      headers: {
        'x-file-id': String(fileId),
        'Content-Type': 'application/octet-stream',
        'Content-Length': stats.size
      }
    }, (res) => {
      if (res.statusCode === 200) {
        logger.info({ fileId, edgeId, edgeHost, edgePort }, 'File proactively replicated to edge node');
        resolve(true);
      } else {
        logger.error({ fileId, edgeId, edgeHost, statusCode: res.statusCode }, 'Edge rejected proactive replication push');
        resolve(false);
      }
    });

    req.on('error', (err) => {
      logger.error({ fileId, edgeId, edgeHost, err: err.message }, 'Failed to push file to edge node (edge offline/unreachable)');
      resolve(false);
    });

    fileStream.pipe(req);
  });
}

module.exports = {
  triggerReplication
};
