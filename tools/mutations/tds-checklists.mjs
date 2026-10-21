// Mutations for the TDS correction checklists (W11 IN17).
//
//   MONGODB_URI="mongodb://127.0.0.1:27118/scratch-tds-intelligence?replicaSet=rs0" node tools/mutation-harness.mjs tools/mutations/tds-checklists.mjs
//
// IN17's gate: a checklist exists for every check status, and the suite fails when one is missing. One mutation
// drops a status, one leaves a status with no steps, and one puts a rate into a step (no checklist states a rate,
// an interest figure or a fee amount).

export const target = "src/services/tds-action-checklists.js";
export const suite = "tests/tds-intelligence-contract.mjs";

export const mutations = [
  {
    name: "1. CERTIFICATE_PENDING has no checklist",
    find: "  CERTIFICATE_PENDING: [\n    \"Confirm the quarterly statement for the period is processed\",\n    \"Generate Form 16 or 16A from TRACES for the deductees concerned\",\n    \"Issue the certificates and record when and how each was issued\",\n  ],\n",
    replace: "",
  },
  {
    name: "2. NEEDS_PROFESSIONAL_REVIEW has an empty checklist",
    find: "  NEEDS_PROFESSIONAL_REVIEW: [\n    \"Open the source rows linked to this check\",",
    replace: "  NEEDS_PROFESSIONAL_REVIEW: [\n  ],\n  UNUSED_REVIEW_STEPS: [\n    \"Open the source rows linked to this check\",",
  },
  {
    name: "3. a step states an interest rate",
    find: "    \"Issue the certificates and record when and how each was issued\",",
    replace: "    \"Issue the certificates; interest at 1.5% per month applies\",",
  },
];
