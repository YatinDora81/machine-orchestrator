if (process.env.VERCEL) {
  module.exports = require("./src/app").createApp();
} else {
  require("./src/server");
}
