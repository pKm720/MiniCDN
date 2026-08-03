function isDockerEnv() {
  return process.env.IS_DOCKER === 'true' || process.env.PGHOST === 'postgres';
}

function getEdgeTarget(edgeId) {
  const id = parseInt(edgeId, 10);
  const envHost = process.env[`EDGE_HOST_${id}`];
  if (envHost) {
    const envPort = process.env[`EDGE_PORT_${id}`] || (3000 + id);
    return { hostname: envHost, port: parseInt(envPort, 10) };
  }

  if (isDockerEnv()) {
    return { hostname: `edge${id}`, port: 3001 };
  }

  return { hostname: '127.0.0.1', port: 3000 + id };
}

function getOriginTarget() {
  if (isDockerEnv()) {
    return { hostname: 'origin', port: parseInt(process.env.PORT_ORIGIN || '4000', 10) };
  }
  return { hostname: '127.0.0.1', port: parseInt(process.env.PORT_ORIGIN || '4000', 10) };
}

function getLbTarget() {
  return { hostname: '127.0.0.1', port: parseInt(process.env.PORT_LB || '3000', 10) };
}

module.exports = {
  isDockerEnv,
  getEdgeTarget,
  getOriginTarget,
  getLbTarget
};
