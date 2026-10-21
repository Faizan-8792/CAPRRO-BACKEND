// Mutations for the AI consent pin (W11 IN4).
//
//   MONGODB_URI=mongodb://127.0.0.1:27117/scratch-ai-consent node tools/mutation-harness.mjs tools/mutations/ai-consent-pin.mjs
//
// The pin's purpose is that a change to a route's consent behaviour fails it, so a decision on OWNER-TODO W11 item
// 1 is deliberate. Each mutation changes one thing in one direction: a check removed where there is one, a check
// added where there is none, and the privacy sentence edited without the routes.

export const suite = "tests/ai-consent-pin-contract.mjs";

export const mutations = [
  {
    name: "1. OCR no longer refuses a file sent without consent",
    target: "src/services/ocr-space.service.js",
    // ocr-space.service.js is stored with CRLF line ends.
    find: "  if (consent !== true) {\r\n    throw httpError(400, \"Explicit consent is required before sending a file to OCR.space\", \"OCR_CONSENT_REQUIRED\");\r\n  }",
    replace: "",
  },
  {
    name: "2. working-paper analysis no longer refuses without consentToExternalProcessing",
    target: "src/services/audit-working-paper.service.js",
    find: "  if (input.consentToExternalProcessing !== true) {",
    replace: "  if (false) {",
  },
  {
    name: "3. /api/audit/insights starts refusing a request without consent",
    target: "src/controllers/audit.controller.js",
    find: "export async function generateInsights(req, res, next) {",
    replace: "export async function generateInsights(req, res, next) {\n  if (req.body?.consent !== true) return res.status(400).json({ ok: false, code: \"AUDIT_AI_CONSENT_REQUIRED\" });",
  },
  {
    name: "4. the privacy page's sentence is changed without the routes",
    target: "../ca-pro-website/privacy.html",
    find: "refuses an AI audit request without explicit consent",
    replace: "does not yet check consent on an AI audit request",
  },
];
