// Mutations for firm invitations: the code, the derived status, the ceiling, and admission.
//
//   node tools/mutation-harness.mjs tools/mutations/firm-invite.mjs
//
// Scored across THREE modules against one suite, because the feature is split across three and a
// per-file score would have said nothing about the feature. Each mutation is a plausible way an
// admission credential stops being one:
//
//   * 1-3   the code itself becomes guessable, biased, or rejected by a shipped client
//   * 4-10  an expiry or a cap fails OPEN -- the worst kind, because the invite still looks capped
//   * 11-15 the ceiling can be exceeded, which is a self-service path into an admin tier
//   * 16-20 admission resolves to the wrong firm, or refuses to fail closed

export const suite = "tests/firm-invite-contract.mjs";
const MODEL = "src/models/FirmInvite.js";
const SERVICE = "src/services/firm-invite.service.js";
const ADMISSION = "src/services/firm-admission.service.js";

export const mutations = [
  // --- the code -----------------------------------------------------------
  {
    name: "1. the code shortens to 6 characters (guessable, and 32^6 is not enough)",
    target: MODEL,
    find: "const CODE_LENGTH = 10;",
    replace: "const CODE_LENGTH = 6;",
  },
  {
    name: "2. the code lengthens to 12 and the extension silently rejects it",
    target: MODEL,
    find: "const CODE_LENGTH = 10;",
    replace: "const CODE_LENGTH = 12;",
  },
  {
    name: "3. a 33rd character biases the modulo and shrinks the real keyspace",
    target: MODEL,
    find: `const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";`,
    replace: `const CODE_ALPHABET = "ABCDEFGHIJKLMNPQRSTUVWXYZ23456789";`,
  },

  // --- expiry and caps, the fail-open family ------------------------------
  {
    name: "4. expiry becomes inclusive, leaving the window open at its own instant",
    target: SERVICE,
    find: "if (invite.expiresAt && new Date(invite.expiresAt).getTime() <= now.getTime()) {",
    replace: "if (invite.expiresAt && new Date(invite.expiresAt).getTime() < now.getTime()) {",
  },
  {
    name: "5. expiry stops being checked at all",
    target: SERVICE,
    find: `  if (invite.expiresAt && new Date(invite.expiresAt).getTime() <= now.getTime()) {
    return "EXPIRED";
  }`,
    replace: "",
  },
  {
    name: "6. a cap is only reached one PAST it, so a single-use invite admits two",
    target: SERVICE,
    find: "if (cap !== null && cap !== undefined && Number(invite.usedCount || 0) >= Number(cap)) {",
    replace: "if (cap !== null && cap !== undefined && Number(invite.usedCount || 0) > Number(cap)) {",
  },
  {
    name: "7. a null cap reads as zero, exhausting every uncapped invite",
    target: SERVICE,
    find: "  if (cap !== null && cap !== undefined && Number(invite.usedCount || 0) >= Number(cap)) {",
    replace: "  if (Number(invite.usedCount || 0) >= Number(cap || 0)) {",
  },
  {
    name: "8. revocation stops being checked",
    target: SERVICE,
    find: `  if (invite.revokedAt) return "REVOKED";`,
    replace: "",
  },
  {
    name: "9. an absent invite reads as LIVE instead of failing closed",
    target: SERVICE,
    find: `  if (!invite) return "REVOKED";`,
    replace: `  if (!invite) return "LIVE";`,
  },
  {
    name: "10. an expiry in the past is accepted at creation, handing out a dead code",
    target: SERVICE,
    find: `    if (parsed.getTime() <= now.getTime()) {
      return { error: "An expiry date must be in the future" };
    }`,
    replace: "",
  },

  // --- the ceiling --------------------------------------------------------
  {
    name: "11. the ceiling check is dropped, so anyone may create an ADMIN invite",
    target: SERVICE,
    find: `  if (!roleAtLeast(ceiling, requested)) {
    return {
      error: "You cannot create an invite for a designation above your own",
    };
  }`,
    replace: "",
  },
  {
    name: "12. the ceiling comparison inverts",
    target: SERVICE,
    find: "  if (!roleAtLeast(ceiling, requested)) {",
    replace: "  if (!roleAtLeast(requested, ceiling)) {",
  },
  {
    name: "13. an unreadable requested role is let through",
    target: SERVICE,
    find: `  if (!isInvitableRole(requested)) {
    return { error: "Choose a designation of Admin, Member or Viewer" };
  }`,
    replace: "",
  },
  {
    name: "14. an ADMIN ceiling activates on redemption with no approval",
    target: SERVICE,
    find: `  if (roleAtLeast(grantsRole, "ADMIN")) {
    return {
      role: PENDING_ELEVATION_ROLE,
      requestedRole: grantsRole,
      approvalState: "PENDING",
    };
  }`,
    replace: "",
  },
  {
    name: "15. an absent ceiling defaults to a grant instead of a refusal",
    target: SERVICE,
    find: `  if (!isInvitableRole(grantsRole)) {
    return null;
  }`,
    replace: `  if (!isInvitableRole(grantsRole)) {
    return { role: "MEMBER", requestedRole: "MEMBER", approvalState: "NOT_REQUIRED" };
  }`,
  },
  {
    name: "16. no caller ceiling is treated as permission to invite",
    target: SERVICE,
    find: `  if (!ceiling) {
    return { error: "You cannot create invites for this workspace" };
  }`,
    replace: "",
  },

  // --- admission ----------------------------------------------------------
  {
    name: "17. an unusable invite is admitted anyway",
    target: ADMISSION,
    find: `  const status = firmInviteStatus(invite, now);
  if (status !== "LIVE") {
    throw admissionError(403, INVITE_REFUSALS[status] || INVITE_REFUSALS.REVOKED);
  }`,
    replace: "",
  },
  {
    name: "18. an unreadable ceiling falls back to MEMBER instead of refusing",
    target: ADMISSION,
    find: `  if (!grant) {`,
    replace: `  if (false) {`,
  },
  {
    name: "19. invites are consulted BEFORE the firm's own join code",
    target: ADMISSION,
    find: `  const firmQuery = FirmModel.findOne({ joinCode: normalized, kind: "SHARED" });`,
    replace: `  const firmQuery = FirmModel.findOne({ joinCode: "\\u0000never", kind: "SHARED" });`,
  },
  {
    name: "20. an inactive firm still admits through its invite",
    target: ADMISSION,
    find: `  if (!firm || !firm.isActive) {
    throw admissionError(404, "Invalid or inactive join code");
  }

  const grant = resolveInviteGrant(invite.grantsRole);`,
    replace: `  const grant = resolveInviteGrant(invite.grantsRole);`,
  },
  {
    name: "21. an empty code is looked up instead of refused",
    target: ADMISSION,
    find: `  if (!normalized) {
    throw admissionError(400, "joinCode is required");
  }`,
    replace: "",
  },
  {
    name: "22. a code stops being uppercased, so a lowercase paste never matches",
    target: ADMISSION,
    find: "  const normalized = typeof code === \"string\" ? code.trim().toUpperCase() : \"\";",
    replace: "  const normalized = typeof code === \"string\" ? code.trim() : \"\";",
  },

  // --- what is shown ------------------------------------------------------
  {
    name: "23. a share link is invented when no base is configured",
    target: SERVICE,
    find: "  if (!base || !code) return null;",
    replace: `  if (!code) return null;
  if (!base) return \`https://caprotoolkit.in/join?code=\${encodeURIComponent(code)}\`;`,
  },
  {
    name: "24. a share link accepts plain http",
    target: SERVICE,
    find: `    if (url.protocol !== "https:") return null;`,
    replace: "",
  },
  {
    name: "25. remaining uses can go negative",
    target: SERVICE,
    find: "    remainingUses: cap === null ? null : Math.max(0, cap - used),",
    replace: "    remainingUses: cap === null ? null : cap - used,",
  },
  {
    name: "26. an uncapped invite reports 0 remaining instead of no limit",
    target: SERVICE,
    find: "    remainingUses: cap === null ? null : Math.max(0, cap - used),",
    replace: "    remainingUses: cap === null ? 0 : Math.max(0, cap - used),",
  },
];
