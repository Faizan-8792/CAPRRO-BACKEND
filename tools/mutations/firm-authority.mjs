// Mutations for the firm authority ladder.
//
//   node tools/mutation-harness.mjs tools/mutations/firm-authority.mjs
//
// Each one is a way this ladder could plausibly be got wrong -- by a later edit, a refactor, or a
// tidy-up -- and each must make tests/firm-role-tier-contract.mjs fail. Several are not
// hypothetical: numbers 2, 3 and 4 are, respectively, the firm-wide read-only switch quietly
// ceasing to apply, the exact disaster DESIGN section 2.3 names ("a VIEWER that accidentally reads
// as MEMBER grants firm-wide write access to everyone who was read-only"), and the stale-OWNER-row
// bug the middleware comment warns about.

export const target = "src/services/firm-authority.service.js";
export const suite = "tests/firm-role-tier-contract.mjs";

export const mutations = [
  {
    name: "1. off-by-one rung: an Admin loses administer rights",
    find: "return held !== null && needed !== null && held >= needed;",
    replace: "return held !== null && needed !== null && held > needed;",
  },
  {
    name: "2. the firm-wide read-only switch stops applying",
    find: `  return role === "MEMBER" && firm?.memberAccess === "READ_ONLY"
    ? "VIEWER"
    : role;`,
    replace: "  return role;",
  },
  {
    name: "3. VIEWER reads as MEMBER (DESIGN 2.3: write access for everyone read-only)",
    find: `  if (declared === "VIEWER") return "VIEWER";`,
    replace: `  if (declared === "VIEWER") return "MEMBER";`,
  },
  {
    name: "4. a stale OWNER row becomes real authority",
    find: `    Boolean(firm?.ownerUserId) &&
    String(firm.ownerUserId) === String(userId)`,
    replace: "    true",
  },
  {
    name: "5. an invite may grant OWNER",
    find: `export const INVITABLE_FIRM_ROLES = ["ADMIN", "MEMBER", "VIEWER"];`,
    replace: `export const INVITABLE_FIRM_ROLES = ["OWNER", "ADMIN", "MEMBER", "VIEWER"];`,
  },
  {
    name: "6. the invite ceiling defaults to the top tier",
    find: `export const DEFAULT_INVITE_ROLE = "MEMBER";`,
    replace: `export const DEFAULT_INVITE_ROLE = "ADMIN";`,
  },
  {
    name: "7. an Admin can mint another Admin",
    find: "  return authority.canInviteAdmins ? \"ADMIN\" : \"MEMBER\";",
    replace: "  return authority.canManageInvites ? \"ADMIN\" : \"MEMBER\";",
  },
  {
    name: "8. an Admin inherits every owner-only power",
    find: `  const ownerOnly = bypass || (!isForeignPersonalWorkspace && isOwner);`,
    replace: `  const ownerOnly = at("ADMIN");`,
  },
  {
    name: "9. somebody else's personal workspace becomes reachable",
    find: `  const isForeignPersonalWorkspace =
    !isOwner && !isSuperAdmin && firm?.kind === "PERSONAL";`,
    replace: "  const isForeignPersonalWorkspace = false;",
  },
  {
    name: "10. a removed member keeps read access",
    find: `    canRead:
      bypass || (!isForeignPersonalWorkspace && hasActiveMembership),`,
    replace: "    canRead: bypass || !isForeignPersonalWorkspace,",
  },
  {
    name: "11. an elevation request activates at the tier it asked for",
    find: `export const PENDING_ELEVATION_ROLE = "MEMBER";`,
    replace: `export const PENDING_ELEVATION_ROLE = "ADMIN";`,
  },
  {
    name: "12. an unknown role string lands on the bottom rung instead of nowhere",
    find: "  return index < 0 ? null : index;",
    replace: "  return index < 0 ? 0 : index;",
  },
  {
    name: "13. no active membership reports the bottom rung instead of null",
    find: `  if (membership?.status !== "ACTIVE") return null;`,
    replace: `  if (membership?.status !== "ACTIVE") return "VIEWER";`,
  },
  {
    name: "14. an account-level FIRM_ADMIN becomes a firm-local administrator",
    find: "  const bypass = isSuperAdmin && !isForeignPersonalWorkspace;",
    replace: `  const bypass =
    (isSuperAdmin || user?.role === "FIRM_ADMIN") && !isForeignPersonalWorkspace;`,
  },
  {
    name: "15. the ladder is reordered so VIEWER outranks OWNER",
    find: `export const FIRM_ROLE_LADDER = ["VIEWER", "MEMBER", "ADMIN", "OWNER"];`,
    replace: `export const FIRM_ROLE_LADDER = ["OWNER", "ADMIN", "MEMBER", "VIEWER"];`,
  },
  {
    name: "16. an ADMIN membership row is read as an ordinary member",
    find: `  if (declared === "ADMIN") return "ADMIN";`,
    replace: `  if (declared === "ADMIN") return "MEMBER";`,
  },
];
