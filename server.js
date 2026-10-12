if (process.env.VERCEL) {
  module.exports = require("./src/app");
} else {
  require("./src/server");
}
