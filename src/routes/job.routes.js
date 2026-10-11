const express = require("express");
const asyncHandler = require("../utils/async-handler");
const jobController = require("../controllers/job.controller");

const router = express.Router();

router.post("/run", asyncHandler(jobController.run));
router.get("/jobs", jobController.list);
router.get("/jobs/:id", jobController.get);
router.post("/jobs/:id/kill", jobController.kill);

module.exports = router;
