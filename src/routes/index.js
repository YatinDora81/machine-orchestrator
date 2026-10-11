const express = require("express");
const pageController = require("../controllers/page.controller");
const jobRoutes = require("./job.routes");
const portRoutes = require("./port.routes");
const publishedRoutes = require("./published.routes");

const router = express.Router();

router.get("/", pageController.index);
router.get("/api/meta", pageController.meta);
router.use("/api", jobRoutes);
router.use("/api", portRoutes);
router.use("/api", publishedRoutes);

module.exports = router;
