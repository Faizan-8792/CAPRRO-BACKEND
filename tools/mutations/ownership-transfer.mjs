// Mutations for handing a shared firm to another member (R27).
//
//   node tools/mutation-harness.mjs tools/mutations/ownership-transfer.mjs
//
// Each is a way the transfer route could plausibly be got wrong, and each must make
// tests/ownership-transfer-e2e.mjs fail. Number 1 is the one the route exists to prevent: anybody
// who is not the owner taking the firm.

export const target = "src/controllers/firm.controller.js";
export const suite = "tests/ownership-transfer-e2e.mjs";

export const mutations = [
  {
    name: "1. the owner check is removed: anybody may take the firm",
    find: "    if (!ownerMembership || String(firm.ownerUserId) !== String(actorUserId)) {",
    replace: "    if (false) {",
  },
  {
    name: "2. a stale OWNER row is accepted as the owner",
    find: "    if (!ownerMembership || String(firm.ownerUserId) !== String(actorUserId)) {",
    replace: "    if (!ownerMembership) {",
  },
  {
    name: "3. the previous owner keeps OWNER: two owners",
    find: '    ownerMembership.role = "ADMIN";',
    replace: '    ownerMembership.role = "OWNER";',
  },
  {
    name: "4. the typed handle is not compared",
    find: '    if (typedHandle !== String(firm.handle || "").toLowerCase()) {',
    replace: "    if (false) {",
  },
  {
    name: "5. a deactivated account can receive the firm",
    find: "    if (target.isActive === false) {",
    replace: "    if (false) {",
  },
  {
    name: "6. a removed member can receive the firm",
    find: 'FirmMembership.findOne({ userId: targetId, firmId: firm._id, status: "ACTIVE" })',
    replace: "FirmMembership.findOne({ userId: targetId, firmId: firm._id })",
  },
  {
    name: "7. the members read offers Transfer to every member",
    find: "      hasActiveOwnerAuthority(firm, callerMembership, userId) &&",
    replace: "      Boolean(callerMembership) &&",
  },
  {
    name: "8. the transfer is not recorded as itself in the activity trail",
    find: '      action: "FIRM_OWNERSHIP_TRANSFERRED",',
    replace: '      action: "FIRM_UPDATED",',
  },
  {
    name: "9. the new owner's account role is left behind",
    find: '        person.role = "FIRM_ADMIN";',
    replace: '        person.role = person.role;',
  },
];
