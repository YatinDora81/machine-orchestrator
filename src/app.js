const express = require("express");
const config = require("./config");
const apiRoutes = require("./routes");
const { proxyGate } = require("./controllers/proxy.controller");
const { send } = require("./utils/http");

function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("etag", false);
  app.use(proxyGate);
  app.use(express.json({ limit: config.bodyLimit }));
  app.use(apiRoutes);
  app.use((_req, res) => {
    send(res, 404, { error: "Not found" });
  });
  app.use((err, _req, res, next) => {
    console.error(err);
    if (res.headersSent) {
      next(err);
      return;
    }
    const tooLarge = err.type === "entity.too.large";
    const badJson = err.type === "entity.parse.failed";
    const status = tooLarge ? 413 : badJson ? 400 : err.status || err.statusCode || 500;
    const message = tooLarge ? "Body too large" : badJson ? "Invalid JSON" : err.message || "Server error";
    send(res, status, { error: message });
  });
  return app;
}

// Vercel loads this file as the Express entry point and needs the app as the default export.
module.exports = createApp();
