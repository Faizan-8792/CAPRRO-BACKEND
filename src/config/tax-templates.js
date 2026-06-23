// src/config/tax-templates.js
// Document checklists for each tax/compliance work type.
// Curated based on real-world Indian CA practice.
// Sessions snapshot the template at creation, so future edits don't disrupt active sessions.

export const TAX_TEMPLATES = {
  GST_MONTHLY: {
    displayName: "GST Monthly Return (GSTR-1 / GSTR-3B)",
    defaultDueDay: 20,
    periodFormat: "monthly",
    documents: [
      { docKey: "sales_register", name: "Sales Register / Outward Supplies (B2B + B2C)", required: true },
      { docKey: "purchase_register", name: "Purchase Register / Inward Supplies", required: true },
      { docKey: "bank_statement", name: "Bank Statement (all accounts)", required: true },
      { docKey: "itc_reco", name: "ITC Reconciliation (GSTR-2A/2B vs Books)", required: true },
      { docKey: "hsn_summary", name: "HSN-wise Summary of Outward Supplies", required: true },
      { docKey: "credit_notes", name: "Credit Notes Issued (Sales)", required: false },
      { docKey: "debit_notes", name: "Debit Notes Issued (Sales)", required: false },
      { docKey: "eway_bills", name: "E-way Bills Summary", required: false },
      { docKey: "rcm_summary", name: "Reverse Charge (RCM) Liability Summary", required: false },
      { docKey: "advances_received", name: "Advances Received Summary", required: false },
      { docKey: "stock_summary", name: "Stock Summary (closing)", required: false },
      { docKey: "cash_book", name: "Cash Book", required: false },
      { docKey: "einvoice_jsons", name: "E-invoice JSONs (if turnover > Rs 5 Cr)", required: false },
      { docKey: "ineligible_itc", name: "Ineligible ITC List (Sec 17(5))", required: false },
      { docKey: "export_invoices", name: "Export Invoices + LUT (if any)", required: false },
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
      { docKey: "itc_reco", name: "ITC Reconciliation (3 months)", required: true },
      { docKey: "hsn_summary", name: "HSN-wise Summary (3 months)", required: true },
      { docKey: "tax_payment_challans", name: "PMT-06 Tax Payment Challans (Months 1 & 2)", required: true },
      { docKey: "iff_filings", name: "IFF Filings (Months 1 & 2)", required: false },
      { docKey: "credit_debit_notes", name: "Credit / Debit Notes (3 months)", required: false },
      { docKey: "rcm_summary", name: "RCM Liability Summary", required: false },
      { docKey: "eway_bills", name: "E-way Bills Summary", required: false },
      { docKey: "export_data", name: "Export Invoices / LUT (if any)", required: false },
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
      { docKey: "hsn_summary_annual", name: "HSN Summary (annual, both inward & outward)", required: true },
      { docKey: "amendments", name: "Amendments Made During the Year", required: false },
      { docKey: "demands_refunds", name: "Demands & Refunds (if any)", required: false },
      { docKey: "rule_42_43", name: "Rule 42/43 ITC Reversal Workings", required: false },
      { docKey: "late_fee_paid", name: "Late Fee Paid Statement", required: false },
      { docKey: "rcm_paid", name: "RCM Paid Schedule", required: false },
      { docKey: "exempt_nil_supplies", name: "Exempt / Nil-rated / Non-GST Supplies", required: false },
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
      { docKey: "turnover_reco_workings", name: "Turnover Reconciliation Workings (Books vs GST)", required: true },
      { docKey: "tax_payable_reco", name: "Tax Payable Reconciliation", required: true },
      { docKey: "itc_reco_workings", name: "ITC Reconciliation Workings", required: true },
      { docKey: "9c_draft", name: "GSTR-9C Draft", required: true },
      { docKey: "auditor_observations", name: "Auditor Observations / Qualifications", required: false },
      { docKey: "additional_liability", name: "Additional Liability Identified Statement", required: false },
      { docKey: "expenses_reco", name: "Expenses-wise ITC Reconciliation", required: false },
      { docKey: "books_extracts", name: "Relevant Ledger Extracts", required: false },
    ],
  },

  TDS_QUARTERLY: {
    displayName: "TDS Quarterly Return (24Q / 26Q / 27Q)",
    defaultDueDay: 31,
    periodFormat: "quarterly",
    documents: [
      { docKey: "salary_register", name: "Salary Register / Payroll Sheet", required: true },
      { docKey: "vendor_invoices", name: "Vendor Invoices (TDS-applicable)", required: true },
      { docKey: "tds_challans", name: "TDS Deposit Challans (BSR + serial number)", required: true },
      { docKey: "deductee_pans", name: "Deductee PAN Cards / List", required: true },
      { docKey: "tds_reco", name: "TDS Reconciliation (Books vs Portal)", required: true },
      { docKey: "form_24q_data", name: "Form 24Q Data (Salary)", required: false },
      { docKey: "form_26q_data", name: "Form 26Q Data (Other than Salary)", required: false },
      { docKey: "form_27q_data", name: "Form 27Q Data (Non-Resident)", required: false },
      { docKey: "form_16_drafts", name: "Form 16 / 16A Drafts", required: false },
      { docKey: "lower_deduction_certs", name: "Lower / Nil Deduction Certificates (Sec 197)", required: false },
      { docKey: "form_15g_15h", name: "Form 15G / 15H Declarations", required: false },
      { docKey: "form_15ca_15cb", name: "Form 15CA / 15CB (Foreign Remittances)", required: false },
      { docKey: "previous_returns", name: "Previous Quarter Returns Acknowledgment", required: false },
    ],
  },

  ITR_INDIVIDUAL: {
    displayName: "Income Tax Return — Individual",
    defaultDueDay: 31,
    periodFormat: "fy",
    documents: [
      { docKey: "pan", name: "PAN Card Copy", required: true },
      { docKey: "aadhaar", name: "Aadhaar Card Copy", required: true },
      { docKey: "form_26as", name: "Form 26AS", required: true },
      { docKey: "ais_tis", name: "AIS / TIS Statement", required: true },
      { docKey: "bank_statements", name: "Bank Statements (all savings/current accounts)", required: true },
      { docKey: "form_16", name: "Form 16 (Salary)", required: false },
      { docKey: "salary_slips", name: "Salary Slips (March)", required: false },
      { docKey: "interest_certs", name: "Interest Certificates (FD, SB, RD)", required: false },
      { docKey: "investment_proofs_80c", name: "Section 80C Investment Proofs (LIC, PPF, ELSS, etc.)", required: false },
      { docKey: "investment_proofs_80d", name: "Section 80D Medical Insurance / Health Check Proofs", required: false },
      { docKey: "donation_receipts_80g", name: "Section 80G Donation Receipts", required: false },
      { docKey: "education_loan_80e", name: "Section 80E Education Loan Interest Certificate", required: false },
      { docKey: "home_loan_cert", name: "Home Loan Interest/Principal Certificate", required: false },
      { docKey: "rental_income", name: "Rental Income Statement / Lease Deed", required: false },
      { docKey: "capital_gains", name: "Capital Gains Statement (Demat / Property / Mutual Funds)", required: false },
      { docKey: "demat_statement", name: "Demat Account Statement (Annual)", required: false },
      { docKey: "foreign_assets", name: "Foreign Income / Assets Disclosure (Schedule FA)", required: false },
      { docKey: "previous_itr", name: "Previous Year ITR Acknowledgment", required: false },
      { docKey: "advance_tax_challans", name: "Advance Tax / Self-Assessment Challans", required: false },
      { docKey: "tds_certificates", name: "TDS Certificates (other than Form 16)", required: false },
    ],
  },

  ITR_FIRM: {
    displayName: "ITR — Firm / LLP",
    defaultDueDay: 31,
    periodFormat: "fy",
    documents: [
      { docKey: "pan_firm", name: "Firm / LLP PAN", required: true },
      { docKey: "partnership_deed", name: "Partnership Deed / LLP Agreement", required: true },
      { docKey: "audited_financials", name: "Audited Financial Statements", required: true },
      { docKey: "computation_total_income", name: "Computation of Total Income", required: true },
      { docKey: "form_26as", name: "Form 26AS", required: true },
      { docKey: "advance_tax_challans", name: "Advance Tax / Self-Assessment Challans", required: true },
      { docKey: "partner_remuneration", name: "Partner Remuneration & Interest Working", required: true },
      { docKey: "depreciation_chart", name: "Depreciation Chart (Companies Act + IT Act)", required: true },
      { docKey: "tax_audit_report", name: "Tax Audit Report (3CB-3CD) — if applicable", required: false },
      { docKey: "capital_account", name: "Partners' Capital Account Statement", required: false },
      { docKey: "drawings_statement", name: "Partners' Drawings Statement", required: false },
      { docKey: "previous_itr", name: "Previous Year ITR Acknowledgment", required: false },
      { docKey: "tds_certificates", name: "TDS Certificates Received", required: false },
      { docKey: "bank_statements", name: "Bank Statements (all firm accounts)", required: false },
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
      { docKey: "advance_tax_challans", name: "Advance Tax / Self-Assessment Challans", required: true },
      { docKey: "depreciation_chart", name: "Depreciation Chart (Companies Act + IT Act)", required: true },
      { docKey: "deferred_tax", name: "Deferred Tax Working (DTA / DTL)", required: true },
      { docKey: "tp_documentation", name: "Transfer Pricing Report (if applicable)", required: false },
      { docKey: "mat_workings", name: "MAT Workings (Sec 115JB)", required: false },
      { docKey: "115ba_election", name: "Section 115BA / 115BAA Election Filing", required: false },
      { docKey: "icds_adjustments", name: "ICDS Adjustments Schedule", required: false },
      { docKey: "shareholding_pattern", name: "Shareholding Pattern (CIN, DIN of promoters)", required: false },
      { docKey: "related_party_schedule", name: "Related Party Transactions Schedule", required: false },
      { docKey: "previous_itr", name: "Previous Year ITR Acknowledgment", required: false },
      { docKey: "tds_certificates", name: "TDS Certificates Received", required: false },
    ],
  },

  TAX_AUDIT: {
    displayName: "Tax Audit (Form 3CA/3CB-3CD)",
    defaultDueDay: 30,
    periodFormat: "fy",
    documents: [
      { docKey: "books_of_accounts", name: "Books of Accounts (Trial Balance + Ledgers)", required: true },
      { docKey: "audited_financials", name: "Audited Financial Statements", required: true },
      { docKey: "bank_confirmations", name: "Bank Confirmations / BRS", required: true },
      { docKey: "loan_confirmations", name: "Loan Confirmations (Banks + Parties)", required: true },
      { docKey: "stock_register", name: "Stock Register / Inventory Records", required: true },
      { docKey: "salary_register", name: "Salary Register", required: true },
      { docKey: "fixed_asset_register", name: "Fixed Asset Register", required: true },
      { docKey: "depreciation_working", name: "Depreciation Working (IT Act)", required: true },
      { docKey: "depreciation_reco", name: "Depreciation Reconciliation (Companies Act vs IT Act)", required: true },
      { docKey: "related_party_schedule", name: "Related Party Transaction Schedule", required: true },
      { docKey: "disallowance_computation", name: "Disallowance Computation (Sec 40A, 43B etc.)", required: true },
      { docKey: "tds_compliance", name: "TDS Compliance Statement", required: true },
      { docKey: "gst_returns", name: "GST Returns Filed (full year)", required: true },
      { docKey: "form_3cd_draft", name: "Form 3CD Draft", required: true },
      { docKey: "loans_above_20k", name: "Loans/Deposits > Rs 20K (Sec 269SS / 269T)", required: false },
      { docKey: "cash_payments_above_10k", name: "Cash Payments > Rs 10K (Sec 40A(3))", required: false },
      { docKey: "section_269st", name: "Cash Receipts > Rs 2 Lakh (Sec 269ST)", required: false },
      { docKey: "icds_adjustments", name: "ICDS Adjustments Schedule", required: false },
      { docKey: "actuarial_gratuity", name: "Actuarial Gratuity / Leave Encashment Report", required: false },
      { docKey: "section_43b_payments", name: "Section 43B Payments Schedule", required: false },
      { docKey: "books_test_check", name: "Books Test-Check Working Papers", required: false },
      { docKey: "qualifications_emoms", name: "Auditor Qualifications / Emphasis of Matter", required: false },
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
      { docKey: "register_of_directors", name: "Register of Directors / KMP", required: false },
      { docKey: "secretarial_audit", name: "Secretarial Audit Report (if applicable)", required: false },
      { docKey: "caro_compliance", name: "CARO 2020 Compliance Notes", required: false },
      { docKey: "cs_certification", name: "Company Secretary Certification (if listed/large)", required: false },
      { docKey: "msme_returns", name: "MSME Form 1 (Half-yearly)", required: false },
      { docKey: "dpt_3", name: "Form DPT-3 (Loans / Deposits Return)", required: false },
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
      { docKey: "new_joiners", name: "New Joiners List", required: false },
      { docKey: "exits", name: "Exits / Final Settlements", required: false },
      { docKey: "state_specific", name: "State-specific Forms / Exemptions", required: false },
      { docKey: "registration_cert", name: "PT Registration Certificate Copy", required: false },
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
      { docKey: "new_joiners_kyc", name: "New Joiners List with KYC (UAN, Aadhaar)", required: false },
      { docKey: "exits", name: "Exits / Final Settlement List", required: false },
      { docKey: "loan_repayments", name: "PF Loan / Advance Repayments", required: false },
      { docKey: "transfer_in", name: "PF Transfer-in Cases", required: false },
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
      { docKey: "el_reco", name: "EL Liability Reconciliation (Books vs Paid)", required: true },
      { docKey: "service_agreements", name: "Service Agreements / SOWs", required: false },
      { docKey: "specified_services", name: "Specified Services Schedule", required: false },
      { docKey: "form_1", name: "Form 1 Draft", required: false },
    ],
  },

  // OTHER / Custom — generic library of commonly-needed documents
  // for any tax/compliance work that doesn't fit the predefined types.
  OTHER: {
    displayName: "Other / Custom",
    defaultDueDay: 0,
    periodFormat: "custom",
    documents: [
      { docKey: "bank_statement", name: "Bank Statement", required: true },
      { docKey: "books_of_accounts", name: "Books of Accounts (TB / Ledgers)", required: true },
      { docKey: "computation_sheet", name: "Computation / Working Sheet", required: true },
      { docKey: "supporting_invoices", name: "Supporting Invoices / Bills", required: false },
      { docKey: "identity_proof", name: "Identity Documents (PAN / Aadhaar)", required: false },
      { docKey: "authorization_letter", name: "Authorization Letter / Engagement Letter", required: false },
      { docKey: "previous_filings", name: "Previous Year Filings / Working Copy", required: false },
      { docKey: "reconciliation_statement", name: "Reconciliation Statement", required: false },
      { docKey: "challan_proof", name: "Challan / Payment Proof", required: false },
      { docKey: "communication_log", name: "Department / Authority Communication Log", required: false },
      { docKey: "agreement_contracts", name: "Agreements / Contracts (if any)", required: false },
      { docKey: "supporting_schedules", name: "Supporting Schedules / Workings", required: false },
    ],
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

// Returns ONLY the required documents for a tax type (used in initial snapshot)
export function getRequiredTemplateDocuments(taxType) {
  return getTemplateDocuments(taxType).filter((d) => d.required);
}

// Auto-suggest period and due date based on taxType + today
export function suggestPeriodAndDueDate(taxType, today = new Date()) {
  const t = TAX_TEMPLATES[taxType] || TAX_TEMPLATES.OTHER;
  const fmt = t.periodFormat;
  const day = t.defaultDueDay || 0;

  const yyyy = today.getUTCFullYear();
  const mm = today.getUTCMonth();

  if (fmt === "monthly") {
    const prev = new Date(Date.UTC(yyyy, mm - 1, 1));
    const py = prev.getUTCFullYear();
    const pm = String(prev.getUTCMonth() + 1).padStart(2, "0");
    const period = `${py}-${pm}`;
    const dueDate = day
      ? new Date(Date.UTC(prev.getUTCFullYear(), prev.getUTCMonth() + 1, day))
      : null;
    return { period, dueDate: dueDate ? dueDate.toISOString() : null };
  }

  if (fmt === "quarterly") {
    const q = Math.floor(mm / 3);
    const prevQuarterIdx = q === 0 ? 3 : q - 1;
    const yearAdj = q === 0 ? yyyy - 1 : yyyy;
    const quarterStartMonth = prevQuarterIdx * 3;
    const period = `Q${prevQuarterIdx + 1}-${yearAdj}-${String(yearAdj + 1).slice(-2)}`;
    const dueDate = day
      ? new Date(Date.UTC(yearAdj, quarterStartMonth + 3, day))
      : null;
    return { period, dueDate: dueDate ? dueDate.toISOString() : null };
  }

  if (fmt === "fy") {
    const fyStart = mm >= 3 ? yyyy - 1 : yyyy - 2;
    const fyEnd = fyStart + 1;
    const period = `FY${fyStart}-${String(fyEnd).slice(-2)}`;
    const dueDate = day
      ? new Date(Date.UTC(fyEnd, day === 30 || day === 29 ? 8 : day === 31 ? 9 : 11, day))
      : null;
    return { period, dueDate: dueDate ? dueDate.toISOString() : null };
  }

  return { period: "", dueDate: null };
}

export default TAX_TEMPLATES;
