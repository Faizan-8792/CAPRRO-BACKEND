// src/services/text/fold.js
//
// W11 IN27 (2026-10-21): one way to fold text for MATCHING, shared by the notice rules, the model-excerpt check,
// import headings and the money and date readers.
//
// Why: the same fact reaches CA PRO written many ways. A notice can be bilingual or wholly in Hindi, with
// Devanagari digits (२०/११/२०२६), an em dash in "DRC—01", a non-breaking space or a zero-width joiner from a PDF.
// A register can come from Tally with full-width characters or curly quotes. Matching each rule against every
// variant would scatter the same bug across files; folding once, here, gives every reader the same plain form.
//
// Folding is for matching only. Whatever is SHOWN or STORED as a source excerpt is cut from the original text,
// through the index map `foldWithMap` returns, so an excerpt stays verbatim.
//
// Per code point: zero-width characters and the soft hyphen are dropped; every Unicode space becomes " "; every
// dash and minus becomes "-"; curly quotes and primes become straight quotes; the digits of 13 scripts (Arabic-
// Indic, Extended Arabic-Indic, NKo, Devanagari, Bengali, Gurmukhi, Gujarati, Oriya, Tamil, Telugu, Kannada,
// Malayalam, Sinhala Lith, full-width) become ASCII digits; anything else is NFKC-normalised. Letters of any
// script are kept: a Hindi heading or name is folded, never deleted.

const ZERO_WIDTH = new Set([0x00ad, 0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x180e]);
const SPACES = new Set([0x00a0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x202f, 0x205f, 0x3000]);
const DASHES = new Set([0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2043, 0x2212, 0xfe58, 0xfe63, 0xff0d]);
const SINGLE_QUOTES = new Set([0x2018, 0x2019, 0x201a, 0x201b, 0x2032, 0xff07]);
const DOUBLE_QUOTES = new Set([0x201c, 0x201d, 0x201e, 0x201f, 0x2033, 0xff02]);
// The zero of each script whose digits run zero to nine in consecutive code points.
const DIGIT_ZEROS = Object.freeze([
  0x0660, 0x06f0, 0x07c0, 0x0966, 0x09e6, 0x0a66, 0x0ae6, 0x0b66, 0x0be6, 0x0c66, 0x0ce6, 0x0d66, 0x0de6, 0xff10,
]);

/** One code point, folded: "" (dropped), or one or more characters. */
export function foldCodePoint(codePoint) {
  if (ZERO_WIDTH.has(codePoint)) return "";
  if (SPACES.has(codePoint)) return " ";
  if (DASHES.has(codePoint)) return "-";
  if (SINGLE_QUOTES.has(codePoint)) return "'";
  if (DOUBLE_QUOTES.has(codePoint)) return '"';
  for (const zero of DIGIT_ZEROS) {
    if (codePoint >= zero && codePoint <= zero + 9) return String(codePoint - zero);
  }
  if (codePoint < 0x80) return String.fromCodePoint(codePoint);
  return String.fromCodePoint(codePoint).normalize("NFKC");
}

/**
 * Folds `text` and returns, for every folded UTF-16 unit, where its source code point starts and ends in the
 * original. `slice(start, end)` cuts the original text behind a folded range [start, end).
 */
export function foldWithMap(text) {
  const source = String(text ?? "");
  let folded = "";
  const starts = [];
  const ends = [];
  let index = 0;
  for (const char of source) {
    const codePoint = char.codePointAt(0);
    const width = char.length;
    const out = foldCodePoint(codePoint);
    for (let unit = 0; unit < out.length; unit += 1) {
      starts.push(index);
      ends.push(index + width);
    }
    folded += out;
    index += width;
  }
  return {
    text: folded,
    original: source,
    slice(start, end) {
      if (end <= start || start >= starts.length) return "";
      return source.slice(starts[start], ends[Math.min(end, ends.length) - 1]);
    },
  };
}

/** Folded text only. */
export function foldText(text) {
  return foldWithMap(text).text;
}

/** Only the digits of every script, to ASCII; nothing else changes. For the "no invented number" checks. */
export function foldDigits(text) {
  let out = "";
  for (const char of String(text ?? "")) {
    const codePoint = char.codePointAt(0);
    const zero = DIGIT_ZEROS.find((start) => codePoint >= start && codePoint <= start + 9);
    out += zero === undefined ? char : String(codePoint - zero);
  }
  return out;
}

/** For comparing two strings as a person reads them: folded, lower case, runs of space collapsed, trimmed. */
export function foldForCompare(text) {
  return foldText(text).toLowerCase().replace(/\s+/g, " ").trim();
}

/** Letters and digits of every script, folded and lower case: a heading's identity for matching. */
export function foldHeadingToken(text) {
  return foldText(text).toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, "");
}
