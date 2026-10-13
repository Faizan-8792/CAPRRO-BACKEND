// src/data/audit-topic-reference.js
//
// Reference data only, extracted from audit-nlp-extension/data/topics.json (the
// extension's bundled, public taxonomy). Used to ground POST /api/audit/insights so the
// model is asked to select and evidence known procedures/mistakes for THIS text rather
// than re-deriving a generic list. This is NOT the classification engine and does not
// decide a topic or a verdict - see decision D1 in EXTENSION-DESKTOP-FEATURE-PARITY.md,
// which explicitly rejects porting the scorer itself to avoid two matchers that drift.
//
// Procedure names and short mistake phrases only (no long descriptions), capped per
// topic, to keep the prompt compact. If the extension's topics.json changes materially,
// regenerate this file from it; do not hand-edit it out of sync with that source.

export const AUDIT_TOPIC_REFERENCE = {
  Inventory: {
    procedures: [
      "Attend Physical Count",
      "Test Count Procedures",
      "NRV Testing",
      "Cut-Off Testing",
      "Third Party Confirmations",
      "Unannounced Physical Verification",
    ],
    mistakes: [
      "Slow-moving stock not written down to NRV despite market evidence",
      "GRN cut-off errors at year-end - goods received recorded in wrong period",
      "Consignment stock incorrectly recorded as owned inventory",
      "Hollow boxes/manipulated count sheets (fraudulent reporting)",
      "No third-party inventory verification for externally held stock",
    ],
  },
  Revenue: {
    procedures: [
      "Contract Terms Examination",
      "Year-End Sales Cut-Off Testing",
      "Customer Confirmations for Terms",
      "Side Agreements Investigation",
      "Channel Stuffing Detection",
      "Returns Reserve Adequacy",
    ],
    mistakes: [
      "Revenue recognized before control transfers to customer (goods still at risk)",
      "Channel stuffing to distributors near year-end to meet targets",
      "Bill-and-hold arrangements without meeting all criteria",
      "Side agreements hiding extended return rights from auditors",
      "Performance obligations not separated in bundled sales contracts",
    ],
  },
  Receivables: {
    procedures: [
      "Customer Balance Confirmations",
      "Subsequent Cash Receipts Testing",
      "Aging Analysis and Provisioning",
      "Expected Credit Loss (ECL) Testing",
      "Related Party Receivables Verification",
      "Analytical Review for Circular / Round-Trip Trading",
    ],
    mistakes: [
      "Fictitious customers/circular trades to inflate revenue",
      "Inadequate bad debt provision despite aging showing old debts",
      "Related party balances without proper terms or collectibility assessment",
      "Disputed balances not adjusted or provided for",
      "Old debts written off without proper authorization/evidence",
    ],
  },
  Payables: {
    procedures: [
      "Vendor Balance Confirmations",
      "Subsequent Payments Testing",
      "Unrecorded Liabilities Search",
      "GRN Cut-Off Verification",
      "Onerous Contract Review",
      "Contingent Liabilities Assessment",
    ],
    mistakes: [
      "Goods received, invoice pending (GRNI) not accrued at year-end",
      "Supplier addresses matching employee addresses (shell company fraud)",
      "Onerous contracts not identified and provisioned",
      "Contingent liabilities not disclosed in financial statements",
      "Restructuring provisions without formal Board approval/plan",
    ],
  },
  FixedAssets: {
    procedures: [
      "Physical Verification of Assets",
      "Title Documents Examination",
      "Depreciation Recalculation",
      "Additions Verification",
      "Disposals and Retirements Testing",
      "Impairment Indicators Assessment",
    ],
    mistakes: [
      "Repairs and maintenance capitalized as capital assets",
      "Useful lives overstated to reduce depreciation expense",
      "Disposals not recorded in fixed asset register (ghost assets)",
      "Related party asset sales without proper approvals/valuations",
      "CWIP remaining incomplete for years without impairment review",
    ],
  },
  CashBank: {
    procedures: [
      "Bank Reconciliation Testing",
      "Bank Balance Confirmations",
      "Physical Cash Count",
      "Bank Cut-Off Statement Testing",
      "Fixed Deposit Verification",
      "Petty Cash Review",
    ],
    mistakes: [
      "Unreconciled differences carried forward without investigation",
      "Kiting between bank accounts to inflate cash balances",
      "FDs not confirmed directly with banks (relying on photocopies)",
      "Petty cash without proper vouchers or oversight",
      "Bank reconciliations prepared long after month-end",
    ],
  },
  IntangibleAssets: {
    procedures: [
      "Intangible Asset Identification",
      "Recognition Criteria Testing",
      "Amortization Testing",
      "Internally Generated Intangibles",
      "Goodwill Impairment Testing",
      "Brand/Trademark Valuations",
    ],
    mistakes: [
      "Internally generated goodwill recognized (prohibited)",
      "Research costs capitalized instead of expensed",
      "Software maintenance costs capitalized as development",
      "Indefinite life assigned without proper justification",
      "Goodwill allocated to wrong cash-generating units",
    ],
  },
  Borrowings: {
    procedures: [
      "Loan Agreement Review",
      "Bank Confirmations for Loans",
      "Interest Expense Testing",
      "Loan Covenant Compliance",
      "Security Documentation Review",
      "Debt Classification Testing",
    ],
    mistakes: [
      "Loan covenants breached but not disclosed/waivers not obtained",
      "Interest expense underaccrued to improve profitability",
      "Borrowing costs capitalized incorrectly to non-qualifying assets",
      "Current portion of long-term debt not reclassified",
      "Security charges not registered with ROC (invalid security)",
    ],
  },
  Equity: {
    procedures: [
      "Share Capital Verification",
      "Reserves Movement Analysis",
      "Dividend Declaration Testing",
      "ESOP/ESPS Testing",
      "Buyback of Shares Verification",
      "Preference Shares Review",
    ],
    mistakes: [
      "Dividends declared but not provided for in financial statements",
      "ESOP expense not recognized or incorrectly calculated",
      "Preference shares misclassified as equity when they are liabilities",
      "Buyback of shares not compliant with Companies Act provisions",
      "Bonus issue made when insufficient reserves available",
    ],
  },
  Tax: {
    procedures: [
      "Deferred Tax Computation",
      "MAT Credit Assessment",
      "GST Reconciliation",
      "TDS Compliance Testing",
      "Advance Tax Verification",
      "Tax Audit Report Review",
    ],
    mistakes: [
      "Deferred tax assets recognized without convincing evidence of future profitability",
      "MAT credit recognized when unlikely to be realized",
      "GST input wrongly claimed on blocked credits (construction, motor vehicles)",
      "TDS not deducted at higher rates for non-filers",
      "Advance tax underpaid resulting in interest liability",
    ],
  },
  Payroll: {
    procedures: [
      "Payroll Register Testing",
      "Gratuity Liability Verification",
      "Leave Encashment Provision",
      "Payroll Headcount Reconciliation & Ghost-Employee Testing",
      "PF/ESI Compliance Testing",
      "Bonus/Incentive Accruals",
    ],
    mistakes: [
      "Ghost employees in payroll (fraud)",
      "Gratuity liability underprovided due to optimistic assumptions",
      "Leave encashment not provided for based on accumulated leaves",
      "PF/ESI dues not remitted on time (statutory default)",
      "Bonus accrued but not paid within 8 months (Section 43B disallowance)",
    ],
  },
  RelatedParty: {
    procedures: [
      "Related Party Identification",
      "Transaction Testing",
      "Arm's Length Assessment",
      "Board Approval Verification",
      "Outstanding Balances Confirmation",
      "Disclosure Completeness",
    ],
    mistakes: [
      "Hidden related parties not disclosed (common directors, relatives)",
      "Non-arm's length pricing favoring related parties",
      "Incomplete disclosure of related party transactions",
      "Board approvals missing for material RPTs",
      "Outstanding balances with related parties not confirmed",
    ],
  },
  GoingConcern: {
    procedures: [
      "Financial Ratios Analysis",
      "Cash Flow Forecasting",
      "Debt Covenant Compliance",
      "Management Plans Assessment",
      "External Factors Review",
      "Legal Proceedings Impact",
    ],
    mistakes: [
      "Going concern assumption used despite significant doubt",
      "Management plans unrealistic/unsubstantiated",
      "Cash flow forecasts based on optimistic assumptions",
      "Debt covenant breaches not properly assessed",
      "Related party support not legally binding",
    ],
  },
  EventsAfter: {
    procedures: [
      "Subsequent Events Review",
      "Adjusting Events Identification",
      "Non-Adjusting Events Assessment",
      "Management Inquiry",
      "Minutes Review",
      "Legal Counsel Communication",
    ],
    mistakes: [
      "Adjusting events not reflected in financial statements",
      "Material non-adjusting events not disclosed",
      "Management not maintaining adequate procedures to identify subsequent events",
      "Board minutes not reviewed for post-year-end events",
      "Legal claims settled after year-end not considered",
    ],
  },
  Contingencies: {
    procedures: [
      "Litigation Review",
      "Guarantees Verification",
      "Warranty Obligations",
      "Capital Commitments",
      "Tax Contingencies",
      "Letter of Comfort Review",
    ],
    mistakes: [
      "Contingent liabilities not disclosed because considered remote",
      "Guarantees given but not recorded/disclosed",
      "Warranty obligations underprovided",
      "Capital commitments not disclosed",
      "Tax contingencies understated",
    ],
  },
  Segment: {
    procedures: [
      "Segment Identification",
      "Aggregation Criteria Testing",
      "Reportable Segment Testing",
      "Segment Revenue Testing",
      "Segment Profit Testing",
      "Segment Assets/Liabilities",
    ],
    mistakes: [
      "Operating segments not identified based on internal reporting",
      "Segments aggregated when they don't meet criteria",
      "Reportable segments omitted because thresholds not met",
      "Intersegment revenue/expense not properly eliminated",
      "Common costs arbitrarily allocated to segments",
    ],
  },
  Consolidation: {
    procedures: [
      "Control Assessment",
      "Subsidiary Identification",
      "Uniform Accounting Policies",
      "Intercompany Elimination",
      "Non-Controlling Interest",
      "Step Acquisition Testing",
    ],
    mistakes: [
      "Subsidiaries omitted from consolidation (SPEs, de facto control)",
      "Intercompany transactions not fully eliminated",
      "Unrealized profits on intra-group sales not eliminated",
      "Non-controlling interest calculated incorrectly",
      "Uniform accounting policies not applied",
    ],
  },
  Fraud: {
    procedures: [
      "Fraud Risk Assessment",
      "Brainstorming Session",
      "Journal Entry Testing",
      "Estimate Testing",
      "Related Party Review",
      "Analytical Review of Transactions Outside the Normal Course",
    ],
    mistakes: [
      "Fraud risk assessment not performed or documented",
      "Journal entry testing limited to automated entries only",
      "Management estimates accepted without skepticism",
      "Related parties not thoroughly investigated",
      "Unusual transactions not questioned",
    ],
  },
  InternalControls: {
    procedures: [
      "Control Environment Assessment",
      "Risk Assessment Process",
      "Information System Review",
      "Control Activities Testing",
      "Monitoring of Controls",
      "IT General Controls",
    ],
    mistakes: [
      "Control environment weak (dominant CEO, lack of oversight)",
      "Key controls not identified or tested",
      "IT controls overlooked in automated environment",
      "Control deficiencies not properly evaluated for significance",
      "Management's IFC assertion not supported by evidence",
    ],
  },
  CSR: {
    procedures: [
      "CSR Eligibility Verification",
      "CSR Committee Review",
      "CSR Policy Examination",
      "CSR Spending Verification",
      "CSR Project Documentation",
      "Unspent Amount Treatment",
    ],
    mistakes: [
      "CSR spending below mandatory 2% without proper explanation",
      "Unspent CSR amount not transferred to specified fund",
      "CSR projects not in prescribed areas (Schedule VII)",
      "CSR spending with related parties without arm's length terms",
      "Incomplete disclosure in Board Report",
    ],
  },
  Investments: {
    procedures: [
      "Existence & Ownership Verification",
      "Classification & Measurement",
      "Impairment Testing",
      "Dividend & Income Verification",
      "Obtain Written Representations",
    ],
    mistakes: [
      "Investments carried at cost despite significant fall in value",
      "Unquoted investments not impaired",
      "Incorrect FV measurement",
      "Dividend income not accrued",
    ],
  },
  Derivatives: {
    procedures: ["Contract Review", "Fair Value Measurement", "Obtain Written Representations"],
    mistakes: [
      "Derivatives not recognised on balance sheet",
      "MTM losses not booked",
      "Embedded derivatives ignored",
    ],
  },
  GovtGrants: {
    procedures: [
      "Grant Eligibility Verification",
      "Recognition & Presentation",
      "Obtain Written Representations",
    ],
    mistakes: [
      "Grants recognised upfront without meeting conditions",
      "Capital grants taken to P&L",
      "Deferred income not maintained",
    ],
  },
  Forex: {
    procedures: ["Forex Revaluation", "Obtain Written Representations"],
    mistakes: [
      "Forex gain/loss not recognised",
      "Incorrect exchange rates used",
      "Forward contracts not accounted",
    ],
  },
  CashFlow: {
    procedures: ["Classification Testing", "Obtain Written Representations"],
    mistakes: [
      "Interest paid classified incorrectly",
      "Non-cash items included",
      "Bank overdraft misclassified",
    ],
  },
  IndAS101: {
    procedures: ["Opening Balance Sheet Review", "Obtain Written Representations"],
    mistakes: ["Incorrect transition date", "Exemptions misapplied", "Reconciliations missing"],
  },
  GeneralAudit: {
    procedures: [
      "Engagement Acceptance & Continuance",
      "Audit Planning & Strategy",
      "Risk Assessment Procedures",
      "Materiality Determination",
      "Designing Audit Responses",
      "Audit Evidence Collection",
    ],
    mistakes: [
      "Engagement letter not signed before commencing audit",
      "Audit planning documentation missing or boilerplate",
      "Materiality calculations not documented or justified",
      "Risk assessment performed without entity-specific risk identification",
      "Sample sizes inadequate or not statistically defensible",
    ],
  },
};
