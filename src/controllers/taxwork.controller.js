const TaxWork = require("../models/TaxWork");

// GET checklist for service
exports.getTaxWork = async (req, res) => {
  try {
    const { service } = req.params;

    const data = await TaxWork.find({
      firmId: req.user.firmId,
      userId: req.user.id,
      serviceType: service
    });

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to load tax work" });
  }
};

// SAVE / UPDATE checklist step
exports.saveTaxWork = async (req, res) => {
  try {
    const { serviceType, checklistStep, completed } = req.body;

    await TaxWork.findOneAndUpdate(
      {
        firmId: req.user.firmId,
        userId: req.user.id,
        serviceType,
        checklistStep
      },
      { completed },
      { upsert: true }
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to save tax work" });
  }
};

// ADD NEW FUNCTIONS
exports.createClient = async (req, res) => {
  try {
    const doc = await TaxWork.create({
      firmId: req.user.firmId,
      userId: req.user.id,
      serviceType: req.body.serviceType,
      clientName: req.body.clientName,
      dueDate: req.body.dueDate
    });
    res.json(doc);
  } catch (err) {
    res.status(500).json({ error: "Failed to create client" });
  }
};

exports.listClients = async (req, res) => {
  try {
    const data = await TaxWork.find({
      firmId: req.user.firmId,
      userId: req.user.id,
      serviceType: req.params.service
    }).sort({ createdAt: -1 });

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to list clients" });
  }
};

exports.deleteClient = async (req, res) => {
  try {
    await TaxWork.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete client" });
  }
};