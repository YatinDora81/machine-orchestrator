const probeService = require("../services/probe.service");
const routeService = require("../services/route.service");
const { send } = require("../utils/http");
const { clampPort } = require("../utils/port");

async function services(_req, res) {
  send(res, 200, await routeService.listServices());
}

async function publish(req, res) {
  const body = req.body || {};
  const port = clampPort(body.port);
  const route = routeService.publish(port, { label: body.label, strip: body.strip !== false });
  const online = (await probeService.tcpOpen(port)) || (await probeService.tcpOpen(port, "::1"));
  send(res, 200, routeService.present(route, online));
}

function remove(req, res) {
  if (!/^[1-9]\d{0,4}$/.test(req.params.port)) {
    send(res, 404, { error: "That port is not published." });
    return;
  }
  const port = Number(req.params.port);
  if (port > 65535 || !routeService.unpublish(port)) {
    send(res, 404, { error: "That port is not published." });
    return;
  }
  send(res, 200, { removed: port });
}

module.exports = { services, publish, remove };
