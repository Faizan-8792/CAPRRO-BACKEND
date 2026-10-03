// Reads of the signed portal map, for the extension (GD28). Signed-in users only (OD8): the map is
// not secret, but it is served to the extension's users, not to the open internet. Publishing is a
// super-admin route in super.controller.js.

import { findPortalMapVersion, latestPortalMapVersion } from "../services/portal-map.service.js";

// The highest published version, or 0 when none has been published - the extension then keeps the
// map it was built with.
export const getLatestPortalMap = async (req, res, next) => {
  try {
    return res.json({ version: await latestPortalMapVersion() });
  } catch (error) {
    return next(error);
  }
};

// One version's signed content. A version never changes once published, so it may be cached.
export const getPortalMapVersion = async (req, res, next) => {
  try {
    const text = String(req.params.version || "");
    const version = Number(text);
    if (!/^[1-9]\d{0,6}$/.test(text)) {
      return res.status(400).json({ ok: false, error: "A portal map version is a whole number from 1.", code: "PORTAL_MAP_MALFORMED" });
    }
    const found = await findPortalMapVersion(version);
    if (!found) {
      return res.status(404).json({ ok: false, error: "No portal map has that version.", code: "PORTAL_MAP_NOT_FOUND" });
    }
    res.set("Cache-Control", "private, max-age=86400");
    return res.json(found);
  } catch (error) {
    return next(error);
  }
};
