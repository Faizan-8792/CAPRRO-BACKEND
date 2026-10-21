// src/services/ai/tasks/supplier-chase-draft.js
//
// W11 IN12: the wording of a message asking a supplier to file or correct, as a TEMPLATE. The model is told
// only the language, the channel, which kinds of problem the message covers and two words for how many and how
// old - never the supplier, the client, an invoice, an amount or a date. It writes {{slots}}; the server fills
// them per supplier. So one draft serves every supplier with the same mix, and the same mix asked again is
// answered from the stored draft without a second call.

import { fail, readFreeText, slotsUsed } from "../ai-validate.js";

// W11 IN33 (2026-10-21): the languages a supplier may read. The model drafts in any of them; a fixed template
// exists in English, Hindi and Hinglish (gst-intelligence.service.js CHASE_TEMPLATES), and any other language
// falls back to the English template, said so on the message.
export const CHASE_LANGUAGES = Object.freeze(["en", "hi", "hinglish", "mr", "gu", "ta", "te", "kn", "ml", "bn", "pa", "or", "ur"]);
export const CHASE_CHANNELS = Object.freeze(["whatsapp", "email"]);
export const CHASE_SLOTS = Object.freeze([
  "supplier",
  "client",
  "period",
  "invoiceCount",
  "invoiceTable",
  "itcAtStake",
  "sender",
]);

// What the model is told the language is; the facts carry this description, not the code.
export const CHASE_LANGUAGE_NAMES = Object.freeze({
  en: "plain Indian English",
  hi: "Hindi in Devanagari script",
  hinglish: "Hinglish (Hindi in Latin script, mixed with English as Indian businesses write)",
  mr: "Marathi in Devanagari script",
  gu: "Gujarati in Gujarati script",
  ta: "Tamil in Tamil script",
  te: "Telugu in Telugu script",
  kn: "Kannada in Kannada script",
  ml: "Malayalam in Malayalam script",
  bn: "Bengali in Bengali script",
  pa: "Punjabi in Gurmukhi script",
  or: "Odia in Odia script",
  ur: "Urdu in Urdu (Nastaliq) script",
});

// How each language is named on screen: its English name, then its own name.
export const CHASE_LANGUAGE_LABELS = Object.freeze({
  en: "English",
  hi: "Hindi (हिन्दी)",
  hinglish: "Hinglish",
  mr: "Marathi (मराठी)",
  gu: "Gujarati (ગુજરાતી)",
  ta: "Tamil (தமிழ்)",
  te: "Telugu (తెలుగు)",
  kn: "Kannada (ಕನ್ನಡ)",
  ml: "Malayalam (മലയാളം)",
  bn: "Bengali (বাংলা)",
  pa: "Punjabi (ਪੰਜਾਬੀ)",
  or: "Odia (ଓଡ଼ିଆ)",
  ur: "Urdu (اردو)",
});

export default {
  name: "supplier_chase_draft",
  operation: "supplier_chase_draft",
  surface: "gst_chase",
  promptVersion: "supplier-chase-v2",
  batchSize: 1,
  // One unit per distinct mix of problems in a run (three yes/no kinds: at most seven).
  maxUnits: 8,
  temperature: 0.3,
  timeoutMs: 25000,
  maxTokensFor: () => 900,
  system: [
    "Task: write a short, polite message from a chartered accountant's office to a supplier of their client, asking the supplier to file or correct invoices in their GST return (GSTR-1) so that the client's GSTR-2B shows them.",
    "The tone is courteous and firm, as between businesses that work together. No threats, no legal citations, no deadlines that are not in the facts.",
    "Placeholders you must use: {{supplier}} for the supplier's name and {{invoiceTable}} where the list of invoices goes.",
    "Placeholders you may use: {{client}}, {{period}}, {{invoiceCount}}, {{itcAtStake}}, {{sender}}.",
  ].join("\n"),
  instructions: [
    'Answer as {"items":[{"id":"<the item id>","subject":"<email subject, or empty for whatsapp>","message":"<the message>"}]}.',
    "Write in the language and for the channel given. A whatsapp message is under ninety words; an email may be longer but stays under two hundred words.",
    "Mention each kind of problem the facts mark true, in plain words: not yet filed, GSTIN typed wrongly on the invoice, an amount that differs.",
    "Whatever the language, write the return names in Latin letters exactly as GSTR-1 and GSTR-2B, and write no other number or date: the placeholders carry them.",
  ].join("\n"),
  validate(item, facts) {
    const message = readFreeText(item.message, { max: 1600, slots: CHASE_SLOTS, label: "message" });
    const used = slotsUsed(message);
    if (!used.includes("supplier")) fail("message does not address {{supplier}}");
    if (!used.includes("invoiceTable")) fail("message does not place {{invoiceTable}}");
    const subject =
      facts.channel === "email"
        ? readFreeText(item.subject, { max: 140, slots: CHASE_SLOTS, label: "subject" })
        : "";
    return { output: { subject, message }, abstained: false };
  },
};
