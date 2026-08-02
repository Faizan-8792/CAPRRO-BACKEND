import { CURRENT_TERMS } from "../config/current-terms.js";
import TermsAcceptance from "../models/TermsAcceptance.js";
import { SUPER_ADMIN_EMAIL } from "../middleware/authorization.middleware.js";

const VERSION_PATTERN = /^[A-Za-z0-9._-]+$/;
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

function reject(req, res, status, error, code) {
  return res.status(status).json({
    ok: false,
    error,
    ...(code ? { code } : {}),
    requestId: req.id || "",
  });
}

function assertSuper(user) {
  const email = String(user?.email || "").trim().toLowerCase();
  if (!user || user.role !== "SUPER_ADMIN" || email !== SUPER_ADMIN_EMAIL) {
    const error = new Error("Super admin only");
    error.statusCode = 403;
    throw error;
  }
}

function parseDateBoundary(value, endOfDay) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  let normalized = raw;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    normalized = `${raw}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`;
  } else if (!ISO_TIMESTAMP_PATTERN.test(raw)) {
    return undefined;
  }

  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export function getCurrentTerms(req, res) {
  res.setHeader("Cache-Control", "public, max-age=300, must-revalidate");
  return res.json({ ok: true, terms: CURRENT_TERMS });
}

// GET /api/super/terms-acceptances?page=&limit=&search=&version=&from=&to=
export async function listTermsAcceptances(req, res, next) {
  try {
    assertSuper(req.user);

    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(
      100,
      Math.max(1, Number.parseInt(req.query.limit, 10) || 25)
    );
    const skip = (page - 1) * limit;

    const search = String(req.query.search || "").trim();
    const version = String(req.query.version || "").trim();
    if (search.length > 320) {
      return reject(req, res, 400, "Search text is too long.", "INVALID_FILTER");
    }
    if (
      version &&
      (version.length > 64 || !VERSION_PATTERN.test(version))
    ) {
      return reject(req, res, 400, "Terms version filter is invalid.", "INVALID_FILTER");
    }

    const from = parseDateBoundary(req.query.from, false);
    const to = parseDateBoundary(req.query.to, true);
    if (from === undefined || to === undefined) {
      return reject(
        req,
        res,
        400,
        "Date filters must be ISO dates or timestamps.",
        "INVALID_FILTER"
      );
    }
    if (from && to && from.getTime() > to.getTime()) {
      return reject(
        req,
        res,
        400,
        "From date must not be after to date.",
        "INVALID_FILTER"
      );
    }

    const filter = {};
    if (search) {
      const safeSearch = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      filter.email = new RegExp(safeSearch, "i");
    }
    if (version) filter.termsVersion = version;
    if (from || to) {
      filter.acceptedAt = {
        ...(from ? { $gte: from } : {}),
        ...(to ? { $lte: to } : {}),
      };
    }

    const [total, acceptances] = await Promise.all([
      TermsAcceptance.countDocuments(filter),
      TermsAcceptance.find(filter)
        .sort({ acceptedAt: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);

    return res.json({
      ok: true,
      currentTerms: {
        version: CURRENT_TERMS.version,
        documentHash: CURRENT_TERMS.documentHash,
      },
      acceptances: acceptances.map((acceptance) => ({
        id: String(acceptance._id),
        userId: String(acceptance.userId),
        email: acceptance.email,
        version: acceptance.termsVersion,
        documentHash: acceptance.documentHash,
        source: acceptance.source,
        acceptedAt: new Date(acceptance.acceptedAt).toISOString(),
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
        hasMore: skip + acceptances.length < total,
      },
    });
  } catch (error) {
    return next(error);
  }
}
