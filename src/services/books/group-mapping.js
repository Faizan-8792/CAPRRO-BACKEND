// src/services/books/group-mapping.js
//
// W10 AP19 (2026-10-17): from a Tally group to the product's standard group, by rule.
//
// Tally predefines 28 groups (15 primary, 13 beneath them). A company's own groups hang from those by a
// PARENT link, so almost every group resolves by walking its parents until a predefined one is reached -
// no guess and no model. What cannot be resolved (a parent that is not in the export and is not a
// predefined name, a cycle) is listed for a person to answer, and a person's answer for a group is used
// from that group up. An unmapped group blocks every pack that needs to know what the ledger under it
// is: it is reported as PENDING_INPUT by that pack, never defaulted.
//
// PURE: no I/O.

export const GROUP_NATURES = Object.freeze({
  ASSET: "ASSET",
  LIABILITY: "LIABILITY",
  INCOME: "INCOME",
  EXPENSE: "EXPENSE",
  OTHER: "OTHER",
});

// code: [label, nature, statement]. Statement is where the group's ledgers appear in the financial
// statements: the balance sheet or the profit and loss account.
const TABLE = [
  ["BRANCH_DIVISIONS", "Branch / Divisions", "OTHER", "BALANCE_SHEET"],
  ["CAPITAL_ACCOUNT", "Capital Account", "LIABILITY", "BALANCE_SHEET"],
  ["RESERVES_SURPLUS", "Reserves & Surplus", "LIABILITY", "BALANCE_SHEET"],
  ["LOANS_LIABILITY", "Loans (Liability)", "LIABILITY", "BALANCE_SHEET"],
  ["LOANS_SECURED", "Secured Loans", "LIABILITY", "BALANCE_SHEET"],
  ["LOANS_UNSECURED", "Unsecured Loans", "LIABILITY", "BALANCE_SHEET"],
  ["BANK_OD", "Bank OD A/c", "LIABILITY", "BALANCE_SHEET"],
  ["CURRENT_LIABILITIES", "Current Liabilities", "LIABILITY", "BALANCE_SHEET"],
  ["DUTIES_TAXES", "Duties & Taxes", "LIABILITY", "BALANCE_SHEET"],
  ["PROVISIONS", "Provisions", "LIABILITY", "BALANCE_SHEET"],
  ["SUNDRY_CREDITORS", "Sundry Creditors", "LIABILITY", "BALANCE_SHEET"],
  ["FIXED_ASSETS", "Fixed Assets", "ASSET", "BALANCE_SHEET"],
  ["INVESTMENTS", "Investments", "ASSET", "BALANCE_SHEET"],
  ["CURRENT_ASSETS", "Current Assets", "ASSET", "BALANCE_SHEET"],
  ["STOCK", "Stock-in-Hand", "ASSET", "BALANCE_SHEET"],
  ["SUNDRY_DEBTORS", "Sundry Debtors", "ASSET", "BALANCE_SHEET"],
  ["CASH", "Cash-in-Hand", "ASSET", "BALANCE_SHEET"],
  ["BANK", "Bank Accounts", "ASSET", "BALANCE_SHEET"],
  ["DEPOSITS_ASSET", "Deposits (Asset)", "ASSET", "BALANCE_SHEET"],
  ["LOANS_ADVANCES_ASSET", "Loans & Advances (Asset)", "ASSET", "BALANCE_SHEET"],
  ["MISC_EXPENSES_ASSET", "Misc. Expenses (ASSET)", "ASSET", "BALANCE_SHEET"],
  ["SUSPENSE", "Suspense A/c", "OTHER", "BALANCE_SHEET"],
  ["SALES", "Sales Accounts", "INCOME", "PROFIT_AND_LOSS"],
  ["DIRECT_INCOMES", "Direct Incomes", "INCOME", "PROFIT_AND_LOSS"],
  ["INDIRECT_INCOMES", "Indirect Incomes", "INCOME", "PROFIT_AND_LOSS"],
  ["PURCHASE", "Purchase Accounts", "EXPENSE", "PROFIT_AND_LOSS"],
  ["DIRECT_EXPENSES", "Direct Expenses", "EXPENSE", "PROFIT_AND_LOSS"],
  ["INDIRECT_EXPENSES", "Indirect Expenses", "EXPENSE", "PROFIT_AND_LOSS"],
];

export const STANDARD_GROUPS = Object.freeze(Object.fromEntries(
  TABLE.map(([code, label, nature, statement]) => [code, Object.freeze({ code, label, nature, statement })]),
));

export const STANDARD_GROUP_CODES = Object.freeze(Object.keys(STANDARD_GROUPS));

// Tally's own names, lower-cased, to a code. "Retained Earnings" is a reserve in newer releases.
const RESERVED_NAMES = new Map([
  ...TABLE.map(([code, label]) => [groupKey(label), code]),
  [groupKey("Retained Earnings"), "RESERVES_SURPLUS"],
]);

export function groupKey(name) {
  return String(name ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

const MAX_HOPS = 24;

/** The standard group for a predefined Tally name, or null. */
export function reservedCodeFor(name) {
  return RESERVED_NAMES.get(groupKey(name)) || null;
}

/**
 * Resolves every group of a snapshot.
 *
 * @param {object} input
 * @param {{name:string,parent:string,reserved:string}[]} input.groups     the snapshot's groups
 * @param {Map<string,string>|Object} [input.mappings]                     person's answers: groupKey -> standard code
 * @returns {{ resolve(name: string): {name:string,chain:string[],standardGroup:string|null,source:"USER"|"TALLY_RESERVED"|"PARENT_CHAIN"|null,reason:string}, all(): object[] }}
 */
export function createGroupResolver({ groups, mappings = new Map() }) {
  const userMap = mappings instanceof Map ? mappings : new Map(Object.entries(mappings));
  const byKey = new Map();
  for (const group of groups) byKey.set(groupKey(group.name), group);

  const resolved = new Map();
  const resolveOne = (name) => {
    const key = groupKey(name);
    if (resolved.has(key)) return resolved.get(key);
    const chain = [];
    const seen = new Set();
    let cursor = name;
    let result = null;
    for (let hop = 0; hop < MAX_HOPS; hop += 1) {
      const cursorKey = groupKey(cursor);
      if (!cursorKey || cursorKey === "primary") break;
      if (seen.has(cursorKey)) {
        result = { standardGroup: null, source: null, reason: `The group parents form a loop at "${cursor}".` };
        break;
      }
      seen.add(cursorKey);
      chain.push(byKey.get(cursorKey)?.name || String(cursor));

      // A person's answer for this group, or for any group above it, wins - the nearest one.
      if (userMap.has(cursorKey)) {
        result = { standardGroup: userMap.get(cursorKey), source: "USER", reason: "" };
        break;
      }
      const group = byKey.get(cursorKey);
      const reservedByName = reservedCodeFor(cursor);
      const reservedByAttribute = group?.reserved ? reservedCodeFor(group.reserved) : null;
      if (reservedByAttribute || reservedByName) {
        result = {
          standardGroup: reservedByAttribute || reservedByName,
          source: chain.length === 1 ? "TALLY_RESERVED" : "PARENT_CHAIN",
          reason: "",
        };
        break;
      }
      if (!group) {
        result = { standardGroup: null, source: null, reason: `"${cursor}" is not a group in this export and is not one of Tally's predefined groups.` };
        break;
      }
      cursor = group.parent;
    }
    if (!result) {
      result = { standardGroup: null, source: null, reason: chain.length >= MAX_HOPS ? "The group tree is deeper than any Tally company." : `"${name}" does not lead to a predefined Tally group.` };
    }
    const entry = { name, chain, ...result };
    resolved.set(key, entry);
    return entry;
  };

  // Names a ledger refers to that the export does not list as groups (predefined groups are often omitted)
  // are resolved on demand by resolve().
  return {
    resolve: resolveOne,
    all() {
      for (const group of groups) resolveOne(group.name);
      return [...resolved.values()];
    },
  };
}

/**
 * The standard group of a ledger, from its parent group. Returns { standardGroup, source, chain, reason }.
 * An unresolvable parent is reported, not defaulted.
 */
export function standardGroupOfLedger(resolver, ledger) {
  const entry = resolver.resolve(ledger.parent || "");
  return { standardGroup: entry.standardGroup, source: entry.source, chain: entry.chain, reason: entry.reason || (ledger.parent ? "" : "The ledger has no parent group.") };
}

export const LENDER_GROUPS = Object.freeze(["LOANS_LIABILITY", "LOANS_SECURED", "LOANS_UNSECURED"]);
export const PARTY_GROUPS = Object.freeze(["SUNDRY_CREDITORS", "SUNDRY_DEBTORS", ...LENDER_GROUPS]);
