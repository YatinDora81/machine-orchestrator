const config = require("./config");
const { createApp } = require("./app");
const { proxyUpgrade } = require("./services/proxy.service");

const server = createApp().listen(config.port, "0.0.0.0", () => {
  console.log(`command sandbox listening on 0.0.0.0:${config.port}`);
});

server.requestTimeout = config.requestTimeoutMs;
server.on("upgrade", (req, socket, head) => {
  proxyUpgrade(req, socket, head).catch((err) => {
    console.error(err);
    if (socket.writable) socket.destroy();
  });
});
