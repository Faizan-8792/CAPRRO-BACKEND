import TaxWork from "../models/TaxWork.js";

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
