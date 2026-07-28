function getEdgeTarget(edgeId) {
  const id = parseInt(edgeId, 10);
  const envHost = process.env[`EDGE_HOST_${id}`];
  if (envHost) {
    const envPort = process.env[`EDGE_PORT_${id}`] || (3000 + id);
    return { hostname: envHost, port: parseInt(envPort, 10) };
  }

  const isDocker = process.env.IS_DOCKER === 'true' || process.env.PGHOST === 'postgres';
  if (isDocker) {
    return { hostname: `edge${id}`, port: parseInt(process.env.PORT_EDGE || '3001', 10) };
  }

  return { hostname: 'localhost', port: 3000 + id };
}

module.exports = {
  getEdgeTarget
};
