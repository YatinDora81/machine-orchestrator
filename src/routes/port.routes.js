const express = require("express");
const asyncHandler = require("../utils/async-handler");
const portController = require("../controllers/port.controller");

const router = express.Router();

router.post("/probe", asyncHandler(portController.probe));
router.post("/scan", asyncHandler(portController.scan));
router.get("/listeners", asyncHandler(portController.listeners));

module.exports = router;
