const express = require('express');
const router = express.Router();
const logger = require('../../shared/logger');
const { runBenchmark } = require('../../benchmark/latency_benchmark');

// POST /lb/run-benchmark — Triggers server-side N=30 benchmark suite
router.post('/run-benchmark', async (req, res) => {
  logger.info('Received request to execute server-side benchmark suite...');

  const previousBenchmarkMode = process.env.BENCHMARK_MODE;
  process.env.BENCHMARK_MODE = 'true';

  try {
    const numFiles = parseInt(req.body && req.body.numFiles || req.query.numFiles || '50', 10);
    const spacingMs = parseInt(req.body && req.body.spacingMs || req.query.spacingMs || '150', 10);

    const reportData = await runBenchmark({
      numFiles,
      spacingMs,
      writeFiles: true
    });

    logger.info({ reductionPercent: reportData.reductionPercent }, 'Server-side benchmark completed successfully');
    return res.json(reportData);
  } catch (err) {
    logger.error({ err }, 'Error executing server-side benchmark');
    return res.status(500).json({ error: 'Failed to execute benchmark', details: err.message });
  } finally {
    process.env.BENCHMARK_MODE = previousBenchmarkMode || '';
  }
});

module.exports = router;
