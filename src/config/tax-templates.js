// src/config/tax-templates.js
// Static catalog of document checklists per tax type.
// Sessions snapshot the template at creation time, so future template edits
// don't disrupt active engagements.

export const TAX_TEMPLATES = {
  GST_MONTHLY: {
    displayName: "GST Monthly Return (GSTR-1 / GSTR-3B)",
    defaultDueDay: 20,
    periodFormat: "monthly",
    documents: [
      { docKey: "sales_register", name: "Sales Register / Outward Supplies", required: true },
      { docKey: "purchase_register", name: "Purchase Register / Inward Supplies", required: true },
      { docKey: "bank_statement", name: "Bank Statement (all accounts)", required: true },
      { docKey: "itc_reco", name: "ITC Reconciliation (GSTR-2A/2B vs Books)", required: true },
      { docKey: "hsn_summary", name: "HSN Summary", required: true },
      { docKey: "credit_notes", name: "Credit Notes Issued", required: false },
      { docKey: "debit_notes", name: "Debit Notes Issued", required: false },
      { docKey: "eway_bills", name: "E-way Bills Summary", required: false },
      { docKey: "rcm_summary", name: "RCM Liability Summary", required: false },
      { docKey: "stock_summary", name: "Stock Summary (closing)", required: false },
      { docKey: "cash_book", name: "Cash Book", required: false },
    ],
  },

  GST_QUARTERLY: {
    displayName: "GST Quarterly Return (QRMP)",
    defaultDueDay: 22,
    periodFormat: "quarterly",
    documents: [
      { docKey: "sales_register", name: "Sales Register (3 months)", required: true },
      { docKey: "purchase_register", name: "Purchase Register (3 months)", required: true },
      { docKey: "bank_statement", name: "Bank Statement (3 months)", required: true },
      { docKey: "iff_filings", name: "IFF Filings (Months 1 & 2)", required: false },
      { docKey: "itc_reco", name: "ITC Reconciliation", required: true },
      { docKey: "hsn_summary", name: "HSN Summary", required: true },
      { docKey: "credit_debit_notes", name: "Credit / Debit Notes", required: false },
      { docKey: "rcm_summary", name: "RCM Liability Summary", required: false },
    ],
  },

  GST_ANNUAL: {
    displayName: "GSTR-9 Annual Return",
    defaultDueDay: 31,
    periodFormat: "fy",
    documents: [
      { docKey: "audited_financials", name: "Audited Financial Statements", required: true },
      { docKey: "all_gstr1", name: "All GSTR-1 (12 months)", required: true },
      { docKey: "all_gstr3b", name: "All GSTR-3B (12 months)", required: true },
      { docKey: "all_gstr2a", name: "All GSTR-2A/2B (12 months)", required: true },
      { docKey: "turnover_reco", name: "Turnover Reconciliation Workings", required: true },
      { docKey: "itc_reco", name: "ITC Reconciliation Workings", required: true },
      { docKey: "tax_paid_summary", name: "Tax Paid Summary (cash + credit)", required: true },
      { docKey: "amendments", name: "Amendments Made During the Year", required: false },
      { docKey: "demands_refunds", name: "Demands & Refunds (if any)", required: false },
      { docKey: "hsn_summary_annual", name: "HSN Summary (annual)", required: true },
    ],
  },

  GST_AUDIT: {
    displayName: "GSTR-9C Reconciliation Statement",
    defaultDueDay: 31,
    periodFormat: "fy",
    documents: [
      { docKey: "gstr9_filed", name: "Filed GSTR-9 Copy", required: true },
      { docKey: "audited_financials", name: "Audited Financials", required: true },
      { docKey: "trial_balance", name: "Trial Balance", required: true },
      { docKey: "turnover_reco_workings", name: "Turnover Reconciliation Workings", required: true },
      { docKey: "tax_payable_reco", name: "Tax Payable Reconciliation", required: true },
      { docKey: "itc_reco_workings", name: "ITC Reconciliation Workings", required: true },
      { docKey: "9c_draft", name: "GSTR-9C Draft", required: true },
      { docKey: "auditor_observations", name: "Auditor Observations / Qualifications", required: false },
    ],
  },

  TDS_QUARTERLY: {
    displayName: "TDS Quarterly Return (24Q / 26Q / 27Q)",
    defaultDueDay: 31,
    periodFormat: "quarterly",
    documents: [
      { docKey: "salary_register", name: "Salary Register / Payroll Sheet", required: true },
      { docKey: "vendor_invoices", name: "Vendor Invoices (TDS-applicable)", required: true },
      { docKey: "tds_challans", name: "TDS Deposit Challans (BSR + serial)", required: true },
      { docKey: "deductee_pans", name: "Deductee PAN Cards / List", required: true },
      { docKey: "form_24q_data", name: "Form 24Q Data (Salary)", required: false },
      { docKey: "form_26q_data", name: "Form 26Q Data (Other than Salary)", required: false },
      { docKey: "form_27q_data", name: "Form 27Q Data (Non-Resident)", required: false },
      { docKey: "tds_reco", name: "TDS Reconciliation (books vs portal)", required: true },
      { docKey: "form_16_drafts", name: "Form 16 / 16A Drafts", required: false },
      { docKey: "lower_deduction_certs", name: "Lower Deduction Certificates", required: false },
    ],
  },

  ITR_INDIVIDUAL: {
    displayName: "Income Tax Return — Individual",
    defaultDueDay: 31,
    periodFormat: "fy",
    documents: [
      { docKey: "pan", name: "PAN Card Copy", required: true },
      { docKey: "aadhaar", name: "Aadhaar Card Copy", required: true },
      { docKey: "form_16", name: "Form 16 (Salary)", required: false },
      { docKey: "form_26as", name: "Form 26AS", required: true },
      { docKey: "ais_tis", name: "AIS / TIS Statement", required: true },
      { docKey: "bank_statements", name: "Bank Statements (all accounts)", required: true },
      { docKey: "interest_certs", name: "Interest Certificates (FD, SB)", required: false },
      { docKey: "investment_proofs_80c", name: "Section 80C Investment Proofs", required: false },
      { docKey: "investment_proofs_80d", name: "Section 80D Medical Insurance Proofs", required: false },
      { docKey: "home_loan_cert", name: "Home Loan Interest/Principal Certificate", required: false },
      { docKey: "rental_income", name: "Rental Income Statement / Lease Deed", required: false },
      { docKey: "capital_gains", name: "Capital Gains Statement (Demat / Property)", required: false },
      { docKey: "foreign_assets", name: "Foreign Income / Assets Disclosure", required: false },
      { docKey: "previous_itr", name: "Previous Year ITR Acknowledgment", required: false },
    ],
  },

  ITR_FIRM: {
    displayName: "ITR — Firm / LLP",
    defaultDueDay: 31,
    periodFormat: "fy",
    documents: [
      { docKey: "pan_firm", name: "Firm PAN", required: true },
      { docKey: "partnership_deed", name: "Partnership Deed / LLP Agreement", required: true },
      { docKey: "audited_financials", name: "Audited Financial Statements", required: true },
      { docKey: "computation_total_income", name: "Computation of Total Income", required: true },
      { docKey: "form_26as", name: "Form 26AS", required: true },
      { docKey: "advance_tax_challans", name: "Advance Tax / Self Assessment Challans", required: true },
      { docKey: "partner_remuneration", name: "Partner Remuneration & Interest Working", required: true },
      { docKey: "tax_audit_report", name: "Tax Audit Report (if applicable)", required: false },
      { docKey: "depreciation_chart", name: "Depreciation Chart (Companies Act + IT Act)", required: true },
      { docKey: "previous_itr", name: "Previous Year ITR Acknowledgment", required: false },
    ],
  },

  ITR_COMPANY: {
    displayName: "ITR — Company",
    defaultDueDay: 31,
    periodFormat: "fy",
    documents: [
      { docKey: "pan_company", name: "Company PAN", required: true },
      { docKey: "audited_financials", name: "Audited Financial Statements", required: true },
      { docKey: "form_3ca_3cb_3cd", name: "Tax Audit Report (3CA/3CB-3CD)", required: true },
      { docKey: "computation_total_income", name: "Computation of Total Income", required: true },
      { docKey: "form_26as", name: "Form 26AS", required: true },
      { docKey: "advance_tax_challans", name: "Advance Tax Challans", required: true },
      { docKey: "depreciation_chart", name: "Depreciation Chart (Companies Act + IT Act)", required: true },
      { docKey: "tp_documentation", name: "Transfer Pricing Report (if applicable)", required: false },
      { docKey: "mat_workings", name: "MAT Workings (115JB)", required: false },
      { docKey: "deferred_tax", name: "Deferred Tax Working", required: false },
      { docKey: "previous_itr", name: "Previous Year ITR Acknowledgment", required: false },
    ],
  },

  TAX_AUDIT: {
    displayName: "Tax Audit (Form 3CA/3CB-3CD)",
    defaultDueDay: 30,
    periodFormat: "fy",
    documents: [
      { docKey: "books_of_accounts", name: "Books of Accounts (TB + Ledgers)", required: true },
      { docKey: "audited_financials", name: "Audited Financial Statements", required: true },
      { docKey: "bank_confirmations", name: "Bank Confirmations / BRS", required: true },
      { docKey: "loan_confirmations", name: "Loan Confirmations (Banks + Parties)", required: true },
      { docKey: "stock_register", name: "Stock Register / Inventory Records", required: true },
      { docKey: "salary_register", name: "Salary Register", required: true },
      { docKey: "fixed_asset_register", name: "Fixed Asset Register", required: true },
      { docKey: "depreciation_working", name: "Depreciation Working (IT Act)", required: true },
      { docKey: "related_party_schedule", name: "Related Party Transaction Schedule", required: true },
      { docKey: "disallowance_computation", name: "Disallowance Computation (40A, 43B etc.)", required: true },
      { docKey: "tds_compliance", name: "TDS Compliance Statement", required: true },
      { docKey: "gst_data", name: "GST Returns Filed (full year)", required: true },
      { docKey: "loans_above_20k", name: "Loans/Deposits > Rs 20K (269SS/T)", required: false },
      { docKey: "cash_payments", name: "Cash Payments > Rs 10K (40A(3))", required: false },
      { docKey: "form_3cd_draft", name: "Form 3CD Draft", required: true },
    ],
  },

  ROC_ANNUAL: {
    displayName: "ROC Annual Filing (AOC-4 + MGT-7)",
    defaultDueDay: 30,
    periodFormat: "fy",
    documents: [
      { docKey: "audited_financials", name: "Audited Financial Statements", required: true },
      { docKey: "directors_report", name: "Director's Report", required: true },
      { docKey: "auditors_report", name: "Auditor's Report", required: true },
      { docKey: "board_resolutions", name: "Board Meeting Resolutions", required: true },
      { docKey: "agm_minutes", name: "AGM Minutes", required: true },
      { docKey: "shareholding_pattern", name: "Shareholding Pattern", required: true },
      { docKey: "director_kyc", name: "Director KYC (DIR-3 KYC)", required: true },
      { docKey: "din_status", name: "DIN Status of all Directors", required: true },
      { docKey: "register_of_members", name: "Register of Members", required: false },
      { docKey: "register_of_directors", name: "Register of Directors", required: false },
      { docKey: "secretarial_audit", name: "Secretarial Audit Report (if applicable)", required: false },
      { docKey: "caro_compliance", name: "CARO 2020 Compliance Notes", required: false },
    ],
  },

  PT: {
    displayName: "Professional Tax Return",
    defaultDueDay: 30,
    periodFormat: "monthly",
    documents: [
      { docKey: "salary_register", name: "Salary Register", required: true },
      { docKey: "pt_slab_workings", name: "PT Slab-wise Workings", required: true },
      { docKey: "pt_challan", name: "PT Challan", required: true },
      { docKey: "employee_count", name: "Employee Count by Slab", required: true },
    ],
  },

  PF_ESI: {
    displayName: "PF / ESI Returns",
    defaultDueDay: 15,
    periodFormat: "monthly",
    documents: [
      { docKey: "salary_register", name: "Salary Register", required: true },
      { docKey: "pf_ecr", name: "PF ECR File", required: true },
      { docKey: "esi_return", name: "ESI Return File", required: true },
      { docKey: "pf_challan", name: "PF Challan", required: true },
      { docKey: "esi_challan", name: "ESI Challan", required: true },
      { docKey: "new_joiners", name: "New Joiners List with KYC", required: false },
      { docKey: "exits", name: "Exits / Final Settlement List", required: false },
    ],
  },

  EQUALISATION_LEVY: {
    displayName: "Equalisation Levy Return",
    defaultDueDay: 7,
    periodFormat: "quarterly",
    documents: [
      { docKey: "advertising_invoices", name: "Foreign Advertising / Digital Service Invoices", required: true },
      { docKey: "non_resident_pan", name: "Non-Resident PAN / Identification", required: true },
      { docKey: "el_challan", name: "EL Deposit Challan", required: true },
      { docKey: "el_reco", name: "EL Liability Reconciliation", required: true },
    ],
  },

  OTHER: {
    displayName: "Other / Custom",
    defaultDueDay: 0,
    periodFormat: "custom",
    documents: [],
  },
};

// Returns array of tax type codes for UI dropdown
export function listTaxTypes() {
  return Object.entries(TAX_TEMPLATES).map(([code, t]) => ({
    code,
    displayName: t.displayName,
    documentCount: (t.documents || []).length,
    periodFormat: t.periodFormat,
  }));
}

// Returns the document checklist for a tax type, deep-cloned to avoid mutation
export function getTemplateDocuments(taxType) {
  const t = TAX_TEMPLATES[taxType];
  if (!t) return [];
  return JSON.parse(JSON.stringify(t.documents || []));
}

// Auto-suggest period string and due date based on taxType + today
export function suggestPeriodAndDueDate(taxType, today = new Date()) {
  const t = TAX_TEMPLATES[taxType] || TAX_TEMPLATES.OTHER;
  const fmt = t.periodFormat;
  const day = t.defaultDueDay || 0;

  const yyyy = today.getUTCFullYear();
  const mm = today.getUTCMonth(); // 0-indexed

  if (fmt === "monthly") {
    // Previous month
    const prev = new Date(Date.UTC(yyyy, mm - 1, 1));
    const py = prev.getUTCFullYear();
    const pm = String(prev.getUTCMonth() + 1).padStart(2, "0");
    const period = `${py}-${pm}`;
    // Due date = day of next-next month after the period
    const dueDate = day
      ? new Date(Date.UTC(prev.getUTCFullYear(), prev.getUTCMonth() + 1, day))
      : null;
    return { period, dueDate: dueDate ? dueDate.toISOString() : null };
  }

  if (fmt === "quarterly") {
    // Find previous quarter
    const q = Math.floor(mm / 3); // 0..3 of current quarter
    const prevQuarterIdx = q === 0 ? 3 : q - 1;
    const yearAdj = q === 0 ? yyyy - 1 : yyyy;
    const quarterStartMonth = prevQuarterIdx * 3;
    const period = `Q${prevQuarterIdx + 1}-${yearAdj}-${String(yearAdj + 1).slice(-2)}`;
    // Due date = day of month after quarter end
    const dueDate = day
      ? new Date(Date.UTC(yearAdj, quarterStartMonth + 3, day))
      : null;
    return { period, dueDate: dueDate ? dueDate.toISOString() : null };
  }

  if (fmt === "fy") {
    // Indian FY: Apr-Mar. If today >= Apr, current FY = yyyy to yyyy+1; previous FY = yyyy-1 to yyyy
    // For ITR/audit, default to PREVIOUS FY (the one that just ended)
    const fyStart = mm >= 3 ? yyyy - 1 : yyyy - 2;
    const fyEnd = fyStart + 1;
    const period = `FY${fyStart}-${String(fyEnd).slice(-2)}`;
    // Due date varies; use 30-Sep, 31-Oct, 31-Dec etc. depending on day field as approximation
    const dueDate = day
      ? new Date(Date.UTC(fyEnd, day === 30 || day === 29 ? 8 : day === 31 ? 9 : 11, day))
      : null;
    return { period, dueDate: dueDate ? dueDate.toISOString() : null };
  }

  return { period: "", dueDate: null };
}

export default TAX_TEMPLATES;
