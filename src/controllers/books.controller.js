// src/controllers/books.controller.js
//
// W10 AP18-AP21 (2026-10-17): HTTP for books snapshots, group mapping, the party master from Tally and the
// snapshot diff. Bodies are checked against per-route field lists inside the service; ids, client and firm
// scoping are enforced there too, so this file only maps requests to calls and statuses.

import {
  createSnapshot,
  diffSnapshots,
  getSnapshot,
  groupMappingReport,
  ingestChunk,
  listParties,
  listSnapshots,
  sealSnapshot,
  seedParties,
  setGroupMapping,
  updateBooksParty,
} from "../services/books-snapshot.service.js";
import { suggestGroupMappings } from "../services/books/books-ai.service.js";

function context(req) {
  return { firmId: req.user.firmId, actorUserId: req.user.id, requestId: req.id || "" };
}

export async function create(req, res, next) {
  try {
    return res.status(201).json({ ok: true, snapshot: await createSnapshot({ ...context(req), input: req.body || {} }) });
  } catch (error) {
    return next(error);
  }
}

export async function list(req, res, next) {
  try {
    return res.json({ ok: true, ...(await listSnapshots({ firmId: req.user.firmId, query: req.query || {} })) });
  } catch (error) {
    return next(error);
  }
}

export async function show(req, res, next) {
  try {
    return res.json({ ok: true, snapshot: await getSnapshot({ firmId: req.user.firmId, snapshotId: req.params.id }) });
  } catch (error) {
    return next(error);
  }
}

export async function chunk(req, res, next) {
  try {
    const result = await ingestChunk({ ...context(req), snapshotId: req.params.id, input: req.body || {} });
    return res.status(result.duplicate ? 200 : 201).json({ ok: true, ...result });
  } catch (error) {
    return next(error);
  }
}

export async function seal(req, res, next) {
  try {
    return res.json({ ok: true, ...(await sealSnapshot({ ...context(req), snapshotId: req.params.id, input: req.body || {} })) });
  } catch (error) {
    return next(error);
  }
}

export async function groups(req, res, next) {
  try {
    return res.json({ ok: true, ...(await groupMappingReport({ firmId: req.user.firmId, snapshotId: req.params.id })) });
  } catch (error) {
    return next(error);
  }
}

export async function suggest(req, res, next) {
  try {
    return res.json({ ok: true, ...(await suggestGroupMappings({ ...context(req), snapshotId: req.params.id, input: req.body || {} })) });
  } catch (error) {
    return next(error);
  }
}

export async function mapGroup(req, res, next) {
  try {
    return res.json({ ok: true, mapping: await setGroupMapping({ ...context(req), input: req.body || {} }) });
  } catch (error) {
    return next(error);
  }
}

export async function seedPartyMaster(req, res, next) {
  try {
    return res.json({ ok: true, ...(await seedParties({ ...context(req), snapshotId: req.params.id })) });
  } catch (error) {
    return next(error);
  }
}

export async function parties(req, res, next) {
  try {
    return res.json({ ok: true, ...(await listParties({ firmId: req.user.firmId, query: req.query || {} })) });
  } catch (error) {
    return next(error);
  }
}

export async function patchParty(req, res, next) {
  try {
    return res.json({ ok: true, party: await updateBooksParty({ ...context(req), partyId: req.params.partyId, input: req.body || {} }) });
  } catch (error) {
    return next(error);
  }
}

export async function diff(req, res, next) {
  try {
    return res.json({ ok: true, diff: await diffSnapshots({ firmId: req.user.firmId, baseId: req.params.id, otherId: req.query?.against }) });
  } catch (error) {
    return next(error);
  }
}
