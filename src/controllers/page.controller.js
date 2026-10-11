const fs = require("fs");
const os = require("os");
const config = require("../config");
const { send } = require("../utils/http");

function index(_req, res) {
  send(res, 200, fs.readFileSync(config.indexPath, "utf8"));
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
