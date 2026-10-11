const { httpError } = require("./http-error");

function clampPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw httpError(400, "Port must be an integer from 1 to 65535.");
  }
  return port;
}

function publicPath(port) {
  return `/p/${port}/`;
}

module.exports = { clampPort, publicPath };
