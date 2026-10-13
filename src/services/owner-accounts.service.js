// The owner's own accounts, left out of the super-admin panel's reports (DS43).
//
// The owner, 2026-10-14: "admin panel se saifullah ya faizan ya highcustom ya id highprice ya
// wbrobotics ya wbmatata yah sab email se koi b data rahe sab ko show mat karna kuki sab mera hi id
// ha to ek sort of clear report nai milta" - every report counted the accounts the owner tests the
// product with, so no report described real customers.
//
// The list lives here and nowhere else. OWNER_ACCOUNT_PATTERNS (comma separated) replaces it
// without a code change. A pattern matches an address with its dots, hyphens, underscores and plus
// signs ignored, so "wbrobotics" matches wb.robotics@... ; a pattern shorter than four characters
// is ignored, so a typo cannot hide everyone. A common name such as "faizan" can match a real
// customer: that is why every report answers with the addresses it left out, the panel shows
// them, and one switch on the panel ("Include my own accounts", ?includeOwn=1) brings them back.
//
// Nothing is deleted or changed. This only narrows what the reports read.

import crypto from "node:crypto";
import User from "../models/User.js";
import Firm from "../models/Firm.js";

const DEFAULT_PATTERNS = Object.freeze([
  "saifullah",
  "faizan",
  "highcustom",
  "highprice",
  "wbrobotics",
  "wbmatata",
]);

// Everything but letters, digits and "@" is ignored, so a pattern can match across "." or "-"
// in the local part but never straddle the "@".
const flatten = (text) => String(text || "").toLowerCase().replace(/[^a-z0-9@]/g, "");

/** The patterns in force: OWNER_ACCOUNT_PATTERNS when it is set, otherwise the owner's list. */
export function ownerAccountPatterns(env = process.env) {
  const raw = String(env.OWNER_ACCOUNT_PATTERNS ?? "").trim();
  const list = raw ? raw.split(",") : DEFAULT_PATTERNS;
  return [...new Set(list.map(flatten).filter((pattern) => pattern.length >= 4 && !pattern.includes("@")))];
}

/** Whether an address belongs to the owner, by the same rule the database query uses. */
export function isOwnerEmail(email, patterns = ownerAccountPatterns()) {
  const flat = flatten(email);
  return Boolean(flat) && patterns.some((pattern) => flat.includes(pattern));
}

// The same rule for MongoDB: each pattern's letters with any run of ignored characters between them.
function patternRegex(patterns) {
  const alternatives = patterns.map((pattern) => [...pattern].join("[^a-z0-9@]*"));
  return new RegExp(alternatives.join("|"), "i");
}

const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");

const NOTHING = Object.freeze({ userIds: [], firmIds: [], emailHashes: [] });

/**
 * The owner's accounts as the reports need them: their ids, their addresses (for the panel's
 * note), the firms they own, and the sha256 recipient hashes the email log is keyed by.
 */
export async function findOwnerAccounts({ patterns = ownerAccountPatterns() } = {}) {
  if (!patterns.length) return { patterns, emails: [], ...NOTHING };
  const candidates = await User.find({ email: { $regex: patternRegex(patterns) } })
    .select("_id email")
    .lean();
  const owners = candidates.filter((user) => isOwnerEmail(user.email, patterns));
  const userIds = owners.map((user) => user._id);
  const firms = userIds.length
    ? await Firm.find({ ownerUserId: { $in: userIds } }).select("_id").lean()
    : [];
  return {
    patterns,
    emails: owners.map((user) => String(user.email)).sort(),
    userIds,
    firmIds: firms.map((firm) => firm._id),
    emailHashes: owners.map((user) => sha256(String(user.email).trim().toLowerCase())),
  };
}

/**
 * What one report leaves out for this request. `userIds`, `firmIds` and `emailHashes` are empty
 * when the panel asked for the owner's accounts to be included (?includeOwn=1). `note` goes into
 * the report's answer as `ownAccounts`, so the panel says what was left out rather than assuming.
 */
export async function reportScope(req) {
  const included = /^(1|true|yes)$/i.test(String(req?.query?.includeOwn ?? ""));
  const owners = await findOwnerAccounts();
  const leftOut = included ? NOTHING : owners;
  return {
    userIds: leftOut.userIds,
    firmIds: leftOut.firmIds,
    emailHashes: leftOut.emailHashes,
    note: {
      leftOut: !included && owners.userIds.length > 0,
      included,
      count: owners.userIds.length,
      emails: owners.emails,
      patterns: owners.patterns,
    },
  };
}

/** A filter that leaves out documents whose `field` is one of `ids` (nothing when `ids` is empty). */
export function without(field, ids) {
  return ids?.length ? { [field]: { $nin: ids } } : {};
}
