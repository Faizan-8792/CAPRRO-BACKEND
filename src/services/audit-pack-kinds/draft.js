// src/services/audit-pack-kinds/draft.js
//
// W10 AP16 + AP28 (2026-10-17): the one way a pack row gets an AI-drafted reason. PURE: no I/O. The service
// (audit-pack.service.js, draftAuditPackRow) makes the call; this file decides what is asked, what is accepted back
// and what a client may be told.
//
// THE CEILING. A draft is words for a person to read, edit and adopt. It is stored beside the row, labelled
// DRAFT FOR REVIEW, and it never touches a stored amount, a state or a decision: the only way its text becomes part
// of a decision is a person putting it in the note, and a note identical to the draft is marked as drafted. A pack
// is complete without any draft; with no AI key the route answers "not available" and nothing else changes.
//
// WHAT IS SENT. The row's facts as the kind chose to quote them (labels and formatted figures) and a closed list of
// categories where the pack has one. No ledger or party names unless the kind quotes them; identifiers are
// redacted again at the provider.
//
// A kind opts in with draftSpec(row) -> null | {
//   purpose        "RATIO_CHANGE_REASON" ...
//   instruction    what to write, one sentence
//   facts          [{ label, value }] strings, already formatted (money as Indian-grouped rupees)
//   choices        optional [{ code, label }]: the model may propose one as a category
// }

export const DRAFT_LABEL = "DRAFT FOR REVIEW";
export const DRAFT_STATUS = "AI_DRAFT";
export const MAX_DRAFT_CHARS = 1_200;
const MAX_FACTS = 40;

export const DRAFT_SYSTEM = [
  "You help a chartered accountant draft wording for an audit working paper.",
  "You are given facts taken from the client's books. Use only those facts.",
  "Never invent a figure, a cause, a date, a law or a standard. Where the facts do not say why something happened, say that the reason is to be obtained from management or the client.",
  "Write plain sentences: no headings, no lists, no markdown, no greeting. This is a draft the accountant will edit before adopting it, so do not address the reader and do not sign off.",
].join(" ");

export function validateSpec(spec) {
  if (!spec || typeof spec !== "object") return false;
  if (!/^[A-Z_]{3,40}$/.test(spec.purpose || "")) return false;
  if (typeof spec.instruction !== "string" || !spec.instruction.trim()) return false;
  if (!Array.isArray(spec.facts) || spec.facts.length === 0 || spec.facts.length > MAX_FACTS) return false;
  if (spec.facts.some((f) => typeof f.label !== "string" || typeof f.value !== "string")) return false;
  if (spec.choices !== undefined && (!Array.isArray(spec.choices) || spec.choices.some((c) => !c.code || !c.label))) return false;
  return true;
}

export function buildDraftPrompt(spec) {
  const lines = [`Task: ${spec.instruction.trim()}`, "", "Facts:", ...spec.facts.map((f) => `- ${f.label}: ${f.value}`), ""];
  if (spec.choices?.length) {
    lines.push("Categories you may propose (use the code exactly):");
    lines.push(...spec.choices.map((c) => `- ${c.code}: ${c.label}`));
    lines.push("", 'Return strict JSON: {"category":"<one code from the list, or an empty string if none fits>","reason":"<one to three sentences>"}.');
    lines.push("Propose a category only if the facts support it; otherwise leave it empty.");
  } else {
    lines.push("Write one to three sentences. Plain text only.");
  }
  return lines.join("\n");
}

const cleanText = (value) =>
  String(value ?? "")
    .replace(/```[a-z]*|```/gi, "")
    .replace(/[*_#>`]+/g, "")
    .replace(/\s*\n\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

/**
 * What came back from the model, reduced to { text, proposedChoice } or null when there is nothing usable.
 * `parse` turns a JSON answer into an object (the provider's tolerant parser); a proposed category that is not in
 * the list the pack offered is dropped, the reason is kept.
 */
export function readDraftAnswer(content, spec, parse) {
  let text = "";
  let proposedChoice = "";
  if (spec.choices?.length) {
    const object = parse(content);
    if (!object) return null;
    text = cleanText(object.reason);
    const code = String(object.category || "").trim().toUpperCase();
    if (spec.choices.some((c) => c.code === code)) proposedChoice = code;
  } else {
    text = cleanText(content);
  }
  if (!text) return null;
  if (/https?:\/\//i.test(text)) return null;
  if (text.length > MAX_DRAFT_CHARS) {
    // Cut at the last full sentence that fits; never mid-sentence.
    const cut = text.slice(0, MAX_DRAFT_CHARS);
    const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("."));
    text = end > 80 ? cut.slice(0, end + 1) : cut.trimEnd();
  }
  return { text, proposedChoice };
}

/** What a client is shown: the words, the label to print above them, and what they were drafted from. */
export function shapeDraft(stored) {
  if (!stored || typeof stored.text !== "string" || !stored.text) return null;
  return {
    text: stored.text,
    status: DRAFT_STATUS,
    label: DRAFT_LABEL,
    purpose: stored.purpose || "",
    proposedChoice: stored.proposedChoice || "",
    quoted: (stored.quoted || []).map((q) => ({ label: q.label, value: q.value })),
    draftedAt: stored.draftedAt || null,
  };
}

/** "AI_DRAFT" when a decision's note is the stored draft word for word, else "" (the person's own words). */
export function noteSourceFor(note, draft) {
  const written = String(note ?? "").trim();
  return written && draft?.text && written === String(draft.text).trim() ? DRAFT_STATUS : "";
}
