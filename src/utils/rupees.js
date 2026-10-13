// Money for a person to read, from integer paise: 125000000 reads "₹12,50,000.00".
//
// Amounts are stored and compared as integer paise; a sentence a CA reads names rupees. Found while
// recording the tutorials (2026-10-13): TDS Health explained a gap as "1250000 minor units" (that is
// ₹12,500.00, readable as twelve lakh), and the working-paper analysis, given paise, wrote that a
// debtor balance of ₹4,12,500 was "41,250,000 minor units".
//
// Grouped by hand, the Indian way (12,34,567), rather than with toLocaleString("en-IN"): that one is
// decided by the runtime's ICU data, and a runtime without it returns Western grouping silently.

export function rupeesFromPaise(minor) {
  const value = typeof minor === "bigint" ? minor : Number.isSafeInteger(minor) ? BigInt(minor) : null;
  if (value === null) return null;
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const digits = String(abs / 100n);
  const paise = String(abs % 100n).padStart(2, "0");
  let head = digits.slice(0, -3);
  const groups = [];
  while (head.length > 2) {
    groups.unshift(head.slice(-2));
    head = head.slice(0, -2);
  }
  if (head) groups.unshift(head);
  const grouped = [...groups, digits.slice(-3)].join(",");
  return `${negative ? "-" : ""}₹${grouped}.${paise}`;
}

// For a sentence: never the word "null" in front of a person.
export function rupeesText(minor) {
  return rupeesFromPaise(minor) || "an amount too large to show";
}
