const fs = require("fs");
const path = require("path");

const rootDir = path.join(__dirname, "../..");
const workspace = path.join(process.cwd(), "workspace");

fs.mkdirSync(workspace, { recursive: true });

module.exports = {
  port: Number(process.env.PORT) || 8787,
  workspace,
  indexPath: path.join(rootDir, "public", "index.html"),
  bodyLimit: "64kb",
  requestTimeoutMs: 120_000,
};
