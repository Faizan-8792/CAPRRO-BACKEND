import TaxWork from "../models/TaxWork.js";

// GET checklist for service
export const getTaxWork = async (req, res) => {
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
export const saveTaxWork = async (req, res) => {
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
export const createClient = async (req, res) => {
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

export const listClients = async (req, res) => {
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

export const deleteClient = async (req, res) => {
  try {
    await TaxWork.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete client" });
  }
};

// SAVE FULL CHECKLIST FOR A CLIENT (DONE BUTTON)
export const saveClientChecklist = async (req, res) => {
  try {
    await TaxWork.findByIdAndUpdate(req.params.id, {
      checklist: req.body.checklist
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to save client checklist" });
  }
};