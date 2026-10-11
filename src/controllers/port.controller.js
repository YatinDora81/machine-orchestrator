const listenerService = require("../services/listener.service");
const probeService = require("../services/probe.service");
const { send } = require("../utils/http");
const { clampPort } = require("../utils/port");

async function probe(req, res) {
  const port = clampPort((req.body || {}).port);
  send(res, 200, await probeService.probe(port));
}

async function scan(req, res) {
  const body = req.body || {};
  const ports = Array.isArray(body.ports) ? body.ports.slice(0, 20) : [];
  send(res, 200, { results: await probeService.scan(ports.map((port) => clampPort(port))) });
}

async function listeners(_req, res) {
  send(res, 200, await listenerService.listAll());
}

module.exports = { probe, scan, listeners };
