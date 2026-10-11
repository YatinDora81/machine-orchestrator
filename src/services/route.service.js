const config = require("../config");
const { LABEL_MAX } = require("../constants");
const routes = require("../repositories/route.repository");
const listenerService = require("./listener.service");
const probeService = require("./probe.service");
const { httpError } = require("../utils/http-error");
const { publicPath } = require("../utils/port");

function present(route, online) {
  return {
    port: route.port,
    label: route.label,
    strip: route.strip,
    path: publicPath(route.port),
    createdAt: route.createdAt,
    online: Boolean(online),
  };
}

function publish(port, options = {}) {
  if (port === config.port) {
    throw httpError(400, "That port is this sandbox. Publish the port your other server is using.");
  }
  const prev = routes.get(port);
  const route = routes.save({
    port,
    label: String(options.label || "").trim().slice(0, LABEL_MAX),
    strip: options.strip !== false,
    createdAt: prev ? prev.createdAt : new Date().toISOString(),
  });
  console.log(`published ${publicPath(port)} -> 127.0.0.1:${port} strip=${route.strip}`);
  return route;
}

function unpublish(port) {
  if (!routes.has(port)) return false;
  routes.remove(port);
  console.log(`unpublished ${publicPath(port)}`);
  return true;
}

async function isOnline(port, open) {
  return open.has(port) || (await probeService.tcpOpen(port)) || (await probeService.tcpOpen(port, "::1"));
}

async function listServices() {
  const listeners = await listenerService.jobListeners();
  const open = new Set(listeners.map((row) => row.port));
  const listed = [];
  for (const route of routes.list()) {
    listed.push(present(route, await isOnline(route.port, open)));
  }
  return { listeners, routes: listed };
}

module.exports = { present, publish, unpublish, listServices, get: (port) => routes.get(port) };
