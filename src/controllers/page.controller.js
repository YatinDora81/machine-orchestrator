const fs = require("fs");
const os = require("os");
const config = require("../config");
const { send } = require("../utils/http");

function index(_req, res) {
  let html;
  try {
    html = fs.readFileSync(config.indexPath, "utf8");
  } catch (err) {
    // On Vercel, public/ is served by the CDN and may not be bundled into the function.
    if (err.code !== "ENOENT") throw err;
    res.redirect(302, "/index.html");
    return;
  }
  send(res, 200, html);
}

function meta(_req, res) {
  send(res, 200, {
    port: config.port,
    hostname: os.hostname(),
    node: process.version,
    platform: process.platform,
    workspace: config.workspace,
    tokenConfigured: Boolean(process.env.CMD_TOKEN),
  });
}

module.exports = { index, meta };
