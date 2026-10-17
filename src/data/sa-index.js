// src/data/sa-index.js
//
// W10 AP33 (2026-10-17). The Standards on Auditing, as a table: number, title, the group the
// standard sits in. No model is involved anywhere in a lookup, so a citation can be opened offline,
// instantly and the same way every time.
//
// WHAT THIS TABLE DOES NOT HOLD, ON PURPOSE
//   - The text of a standard, or a paraphrase of it. A reader who wants a paragraph reads the
//     standard itself; the clients say so beside every entry.
//   - An effective date or a paragraph reference. Both fields exist (`effectiveDate`, ISO day or
//     null) so a verified value can be added without changing any client, but nothing here has been
//     checked against the Institute's text, so every entry carries null and the clients print
//     "Not recorded in this index" instead of a guess. A wrong effective date on an audit file is
//     worse than none.
//   - SA 600. Its title changed with the revision, and which revision applies to which period is a
//     question for the Institute's notification, not for this table. A lookup of SA 600 therefore
//     answers "not in the index", which is true.
//
// GENERATED INTO THE CLIENTS: tools/generate-sa-index.mjs writes the extension's data/sa-index.json and
// the Windows app's Core/Audit/StandardsIndex.generated.cs from THIS file; `--check` fails on drift.
// Edit here, run the generator, commit all three. Pure ASCII.

const entry = (number, title, group) => Object.freeze({ number, title, group, effectiveDate: null });

export const SA_GROUPS = Object.freeze([
  "General principles and responsibilities",
  "Risk assessment and response",
  "Audit evidence",
  "Using the work of others",
  "Conclusions and reporting",
  "Specialised areas",
]);

const G = SA_GROUPS;

export const SA_INDEX = Object.freeze([
  entry(200, "Overall Objectives of the Independent Auditor and the Conduct of an Audit in Accordance with Standards on Auditing", G[0]),
  entry(210, "Agreeing the Terms of Audit Engagements", G[0]),
  entry(220, "Quality Control for an Audit of Financial Statements", G[0]),
  entry(230, "Audit Documentation", G[0]),
  entry(240, "The Auditor's Responsibilities Relating to Fraud in an Audit of Financial Statements", G[0]),
  entry(250, "Consideration of Laws and Regulations in an Audit of Financial Statements", G[0]),
  entry(260, "Communication with Those Charged with Governance", G[0]),
  entry(265, "Communicating Deficiencies in Internal Control to Those Charged with Governance and Management", G[0]),
  entry(299, "Responsibility of Joint Auditors", G[0]),
  entry(300, "Planning an Audit of Financial Statements", G[1]),
  entry(315, "Identifying and Assessing the Risks of Material Misstatement", G[1]),
  entry(320, "Materiality in Planning and Performing an Audit", G[1]),
  entry(330, "The Auditor's Responses to Assessed Risks", G[1]),
  entry(402, "Audit Considerations Relating to an Entity Using a Service Organisation", G[1]),
  entry(450, "Evaluation of Misstatements Identified during the Audit", G[1]),
  entry(500, "Audit Evidence", G[2]),
  entry(501, "Audit Evidence - Specific Considerations for Selected Items", G[2]),
  entry(505, "External Confirmations", G[2]),
  entry(510, "Initial Audit Engagements - Opening Balances", G[2]),
  entry(520, "Analytical Procedures", G[2]),
  entry(530, "Audit Sampling", G[2]),
  entry(540, "Auditing Accounting Estimates and Related Disclosures", G[2]),
  entry(550, "Related Parties", G[2]),
  entry(560, "Subsequent Events", G[2]),
  entry(570, "Going Concern", G[2]),
  entry(580, "Written Representations", G[2]),
  entry(610, "Using the Work of Internal Auditors", G[3]),
  entry(620, "Using the Work of an Auditor's Expert", G[3]),
  entry(700, "Forming an Opinion and Reporting on Financial Statements", G[4]),
  entry(701, "Communicating Key Audit Matters in the Independent Auditor's Report", G[4]),
  entry(705, "Modifications to the Opinion in the Independent Auditor's Report", G[4]),
  entry(706, "Emphasis of Matter Paragraphs and Other Matter Paragraphs in the Independent Auditor's Report", G[4]),
  entry(710, "Comparative Information - Corresponding Figures and Comparative Financial Statements", G[4]),
  entry(720, "The Auditor's Responsibilities Relating to Other Information", G[4]),
  entry(800, "Special Considerations - Audits of Financial Statements Prepared in Accordance with Special Purpose Frameworks", G[5]),
  entry(805, "Special Considerations - Audits of Single Financial Statements and Specific Elements, Accounts or Items of a Financial Statement", G[5]),
  entry(810, "Engagements to Report on Summary Financial Statements", G[5]),
]);

const BY_NUMBER = new Map(SA_INDEX.map((e) => [e.number, e]));

export const NOT_RECORDED = "Not recorded in this index";

/** The entry for a standard number (320 or "320" or "SA 320"), or null. */
export function findStandard(value) {
  const digits = String(value ?? "").match(/\d{3}/);
  return digits ? BY_NUMBER.get(Number(digits[0])) || null : null;
}

/**
 * Every standard number named in a piece of text, in the order first named, without repeats:
 * "SA 320, SA 530" -> [320, 530]; "SA 320/530" -> [320, 530]; "SA 560 and 570" -> [560, 570].
 * Text with no standard in it ("Ind AS 115", "") gives []. A bare three-digit number is not a standard:
 * the word SA has to be there.
 */
export function standardNumbers(text) {
  const out = [];
  const seen = new Set();
  const groups = String(text ?? "").matchAll(/\bSAs?\s*((?:\d{3}(?:\s*(?:,|\/|&|and)\s*(?=\d{3}))?\s*)+)/gi);
  for (const group of groups) {
    for (const match of group[1].matchAll(/\d{3}/g)) {
      const number = Number(match[0]);
      if (!seen.has(number)) {
        seen.add(number);
        out.push(number);
      }
    }
  }
  return out;
}

/**
 * What a citation resolves to. `resolved` are index entries; `unresolved` are numbers the text named
 * that the index does not hold (shown as "not in the index", never invented).
 */
export function resolveCitation(text) {
  const numbers = standardNumbers(text);
  const resolved = [];
  const unresolved = [];
  for (const number of numbers) {
    const found = BY_NUMBER.get(number);
    if (found) resolved.push(found);
    else unresolved.push(number);
  }
  return { numbers, resolved, unresolved };
}
