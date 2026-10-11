const express = require("express");
const asyncHandler = require("../utils/async-handler");
const routeController = require("../controllers/route.controller");

const router = express.Router();

router.get("/services", asyncHandler(routeController.services));
router.post("/routes", asyncHandler(routeController.publish));
router.delete("/routes/:port", routeController.remove);

module.exports = router;
