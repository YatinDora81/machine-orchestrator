const http = require("http");
const net = require("net");
const config = require("../config");

function tcpOpen(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (open) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(1000);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

function httpGet(port) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/", method: "GET", timeout: 2000 },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size <= 800) chunks.push(chunk);
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString("utf8").slice(0, 400),
          });
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ error: "timeout" });
    });
    req.on("error", (err) => resolve({ error: err.message }));
    req.end();
  });
}

async function probe(port) {
  const tcp = await tcpOpen(port);
  if (!tcp) return { port, tcp: false, thisService: port === config.port };
  return { port, tcp: true, http: await httpGet(port), thisService: port === config.port };
}

async function scan(ports) {
  const unique = [...new Set(ports)];
  const results = [];
  for (const port of unique) results.push(await probe(port));
  return results;
}

module.exports = { tcpOpen, probe, scan };
