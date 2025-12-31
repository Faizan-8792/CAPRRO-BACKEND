const router = require("express").Router();
const auth = require("../middleware/auth.middleware");
const controller = require("../controllers/taxwork.controller");

router.get("/:service", auth, controller.getTaxWork);
router.post("/", auth, controller.saveTaxWork);

module.exports = router;
