const routes = new Map();
const upstreamHosts = new Map();

function get(port) {
  return routes.get(port) || null;
}

function save(route) {
  routes.set(route.port, route);
  return route;
}

function has(port) {
  return routes.has(port);
}

function remove(port) {
  routes.delete(port);
  upstreamHosts.delete(port);
}

function list() {
  return [...routes.values()].sort((a, b) => a.port - b.port);
}

function getHost(port) {
  return upstreamHosts.get(port) || null;
}

function saveHost(port, entry) {
  upstreamHosts.set(port, entry);
}

module.exports = { get, save, has, remove, list, getHost, saveHost };
