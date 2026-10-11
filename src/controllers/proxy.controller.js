const routeService = require("../services/route.service");
const { proxyHttp } = require("../services/proxy.service");
const { textPage } = require("../utils/http");

function proxyGate(req, res, next) {
  const match = req.path.match(/^\/p\/([1-9]\d{0,4})(\/.*)?$/);
  if (!match) {
    next();
    return;
  }
  const port = Number(match[1]);
  if (port > 65535) {
    textPage(res, 404, "Not a port.");
    return;
  }
  const route = routeService.get(port);
  if (!route) {
    textPage(res, 404, `Port ${port} is not published. Open the sandbox page and publish it.`);
    return;
  }
  if ((req.method === "GET" || req.method === "HEAD") && req.path === `/p/${port}`) {
    const query = req.originalUrl.includes("?")
      ? req.originalUrl.slice(req.originalUrl.indexOf("?"))
      : "";
    res.writeHead(308, {
      Location: `/p/${port}/${query}`,
      "Cache-Control": "no-store",
    });
    res.end();
    return;
  }
  proxyHttp(req, res, route).catch(next);
}

module.exports = { proxyGate };
