import TaxWork from "../models/TaxWork.js";

export const createClient = async (req, res) => {
  const doc = await TaxWork.create({
    firmId: req.user.firmId,
    userId: req.user.id,
    serviceType: req.body.serviceType,
    clientName: req.body.name,
    dueDate: req.body.dueDate,
    checklist: {}
  });
  res.json(doc);
};

export const listClients = async (req, res) => {
  const data = await TaxWork.find({
    firmId: req.user.firmId,
    userId: req.user.id,
    serviceType: req.params.service
  }).sort({ updatedAt: -1 });

  res.json(data.map(d => ({
    _id: d._id,
    name: d.clientName,
    dueDate: d.dueDate
  })));
};

export const getChecklist = async (req, res) => {
  const doc = await TaxWork.findById(req.params.clientId);
  res.json(doc.checklist || {});
};

export const saveChecklist = async (req, res) => {
  await TaxWork.findByIdAndUpdate(req.params.clientId, {
    checklist: req.body
  });
  res.json({ ok: true });
};

export const deleteClient = async (req, res) => {
  await TaxWork.findByIdAndDelete(req.params.clientId);
  res.json({ ok: true });
};
