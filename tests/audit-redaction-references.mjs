// tests/audit-redaction-references.mjs
//
// B6 (EXTENSION-DESKTOP-FEATURE-PARITY.md §4-5), fixing B14: redactPII's
// Aadhaar rule matched a purchase-order, GRN or cheque reference exactly as
// readily as a real Aadhaar number, and its long-digit-run rule destroyed an
// ordinary integer-paise amount above roughly Rs 2.5 crore - both silently,
// since callDeepSeek never logs what redactPII changed before sending a prompt.
//
// Six reference-number formats from §4 are covered (PO, GRN, cheque, invoice,
// bill/voucher, order/transaction reference), plus the paise-amount cases in
// both prose and JSON-field shape, all while confirming a real Aadhaar number,
// GSTIN, PAN, email and mobile number are still redacted exactly as before -
// narrowing the rule must not create a new leak.

import { redactPII } from "../src/services/deepseek-provider.service.js";

const checks = [];
const check = (name, pass, detail = "") => checks.push({ name, pass, detail });

function unchanged(label, text) {
  check(
    `business reference survives: ${label}`,
    redactPII(text) === text,
    redactPII(text),
  );
}

function redacted(label, text, expectedSubstring) {
  const out = redactPII(text);
  check(
    `PII is still redacted: ${label}`,
    out !== text && out.includes(expectedSubstring),
    out,
  );
}

// ─── The six reference formats named in §4 ──────────────────────────

unchanged(
  "purchase order, hyphenated",
  "PO-4521-8834-1029 raised for vendor Sharma Traders",
);
unchanged(
  "purchase order, labelled with colon",
  "PO Number: 4521 8834 1029 pending approval",
);
unchanged(
  "goods receipt note (GRN)",
  "GRN: 4521 8834 1029 recorded at year-end for the inventory count",
);
unchanged(
  "cheque, spaced",
  "Cheque No 4521 8834 1029 issued to the supplier on 15 March",
);
unchanged(
  "cheque, abbreviated with dot",
  "Chq. 4521-8834-1029 dated 15 Feb was returned unpaid",
);
unchanged(
  "invoice reference",
  "Invoice No. 4521 8834 1029 raised against the March dispatch",
);
unchanged(
  "bill reference",
  "Bill No: 4521 8834 1029 outstanding since January",
);
unchanged(
  "voucher reference",
  "Voucher 4521 8834 1029 supports the journal entry",
);
unchanged(
  "challan reference",
  "Challan No. 4521 8834 1029 accompanied the goods transfer",
);
unchanged(
  "generic order reference",
  "Order Ref: 4521 8834 1029 confirmed with the customer",
);
unchanged(
  "sales order reference",
  "Sale Order 4521 8834 1029 was partially executed",
);
unchanged(
  "transaction reference",
  "Txn Ref: 4521 8834 1029 appears in the bank statement",
);

// ─── Paise amounts above the old ~Rs 2.5 crore ceiling ──────────────

unchanged(
  "JSON minor-unit field, no space, Rs 25 crore",
  '"currentAmountMinor":2500000000000,"note":"provision"',
);
unchanged(
  "JSON minor-unit field, spaced, Rs 90 crore",
  '"disputedMinor": 9000000000000, "category": "TAX"',
);
unchanged(
  "rupee symbol prefix, Rs 90 crore in paise",
  "the dispute involves \u20b99000000000000 in total tax demand",
);
unchanged(
  "Rs prefix, Rs 25 crore in paise",
  "Rs 2500000000000 was recognised as revenue for the year",
);
unchanged(
  "INR prefix, Rs 25 crore in paise",
  "INR 2500000000000 was the closing balance reported",
);

// ─── The redaction must still fire where it is genuinely needed ────

redacted(
  "real Aadhaar number, unlabelled",
  "his Aadhaar number is 234567890123 on the KYC form",
  "[AADHAAR]",
);
redacted(
  "real Aadhaar number, mid-sentence, 4-4-4 grouped",
  "the aadhaar 2345 6789 0123 was verified separately",
  "[AADHAAR]",
);
redacted(
  "bank account number - a genuine PII label, not a business-document reference",
  "A/c No is 123456789012 for the NEFT transfer",
  "[AADHAAR]",
);
redacted(
  "long bare identifier, no label at all",
  "internal reference code 987654321098765 was cited",
  "[NUM]",
);
redacted(
  "GSTIN unaffected by the narrowing",
  "GSTIN 27AAAAA0000A1Z5 is printed on the invoice",
  "[GSTIN]",
);
redacted(
  "PAN unaffected by the narrowing",
  "the vendor's PAN is ABCDE1234F on file",
  "[PAN]",
);
redacted(
  "email unaffected by the narrowing",
  "contact the auditor at reviewer@example.com now",
  "[EMAIL]",
);
redacted(
  "mobile number unaffected by the narrowing",
  "call the client on 9876543210 today",
  "[PHONE]",
);

// ─── The human's own three sentences, unaffected either way ────────
//
// The plan's §4 "what is not the cause" section already established that these
// survive intact under the OLD rules. They must survive identically under the
// narrowed ones, because none of these figures or dates is Aadhaar-shaped or
// exceeds the paise-amount threshold.

const humanPassage =
  "During the physical stock verification, the company disclosed a sale and repurchase " +
  "arrangement worth Rs 42 lakh with a related dealer. Dispatch records worth Rs 18.5 " +
  "lakh dated 31 March 2026 for two customers who had requested delivery only after " +
  "5 April, and Rs 7.2 lakh of credit notes were issued after the year-end.";

check(
  "the human's benchmark passage is completely unchanged by redaction",
  redactPII(humanPassage) === humanPassage,
  redactPII(humanPassage),
);

// ─── Report ───────────────────────────────────────────────────────

let passed = 0;
for (const entry of checks) {
  const mark = entry.pass ? "PASS" : "FAIL";
  if (entry.pass) passed += 1;
  console.log(
    `[${mark}] ${entry.name}${entry.detail ? ` — ${entry.detail}` : ""}`,
  );
}

const total = checks.length;
console.log(`\nAudit redaction references: ${passed}/${total}`);

if (passed !== total) {
  console.error(`\n${total - passed} check(s) failed.`);
  process.exit(1);
}
