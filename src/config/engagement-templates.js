const ENGAGEMENT_STATUSES = Object.freeze([
  "DRAFT",
  "PLANNING",
  "IN_PROGRESS",
  "CLIENT_INPUT_PENDING",
  "INTERNAL_REVIEW",
  "CLIENT_REVIEW",
  "FINALIZATION",
  "COMPLETE",
  "ARCHIVED",
]);

const ENGAGEMENT_TYPES = Object.freeze([
  "STATUTORY_AUDIT",
  "INTERNAL_AUDIT",
  "STOCK_AUDIT",
  "BANK_AUDIT",
  "TAX_ADVISORY",
  "DUE_DILIGENCE",
  "SECRETARIAL_COMPLIANCE",
  "FORENSIC_AUDIT",
  "GST_ASSESSMENT",
  "GST_REFUND",
  "GST_AUDIT",
]);

const SHARED_STAGES = Object.freeze([
  { key: "INTAKE", title: "Intake and acceptance" },
  { key: "SCOPE", title: "Scope confirmation" },
  { key: "PLANNING", title: "Planning and requests" },
  { key: "FIELDWORK", title: "Procedures and evidence" },
  { key: "RESPONSE", title: "Responses and follow-up" },
  { key: "REVIEW", title: "Internal and client review" },
  { key: "DELIVERY", title: "Deliverable record" },
  { key: "CLOSURE", title: "Closure and outcome" },
]);

const FULL_LIFECYCLE = Object.freeze([
  { capability: "CLIENT_INTAKE", component: "engagement" },
  { capability: "SCOPE_CONFIRMATION", component: "scope" },
  { capability: "OWNER_AND_REVIEWER", component: "assignments" },
  { capability: "CHECKLIST_AND_DOCUMENTS", component: "checklistAndClientRequests" },
  { capability: "MILESTONES_AND_DEADLINES", component: "milestones" },
  { capability: "FINDINGS_AND_ISSUES", component: "findings" },
  { capability: "CLIENT_COMMUNICATION", component: "managementResponseAndClientRequests" },
  { capability: "REVIEW_AND_APPROVAL", component: "templateAndFinalReview" },
  { capability: "DELIVERABLE_RECORD", component: "deliverables" },
  { capability: "CLOSURE_AND_OUTCOME", component: "closure" },
  { capability: "SEARCHABLE_HISTORY", component: "activity" },
  { capability: "EXPORT", component: "snapshotExport" },
]);

const COMMON_CLOSURE_REQUIREMENTS = Object.freeze([
  "TEMPLATE_REVIEW_ATTESTED",
  "REQUIRED_CHECKLIST_RESOLVED",
  "REQUIRED_CLIENT_REQUESTS_RESOLVED",
  "REQUIRED_MILESTONES_COMPLETE",
  "REQUIRED_DELIVERABLES_APPROVED",
  "REVIEW_POINTS_RESOLVED",
  "FINDINGS_REVIEWED_AND_CLOSED",
  "CURRENT_FINAL_REVIEW_APPROVED",
  "CLOSURE_SUMMARY_RECORDED",
]);

function item(key, title, category, required = true) {
  return { key, title, category, required };
}

function defineTemplate({
  engagementType,
  title,
  purpose,
  checklist,
  milestones,
  clientRequests,
  deliverables,
  findingCategories,
  safetyBoundaries = [],
}) {
  return {
    templateId: `CA_PRO_${engagementType}`,
    version: 1,
    engagementType,
    title,
    purpose,
    catalogReviewState: "REQUIRES_FIRM_ATTESTATION",
    catalogReviewNotice:
      "Template content is operational scaffolding. CA PRO does not verify reviewer qualifications or professional correctness.",
    stages: SHARED_STAGES,
    lifecycleCoverage: FULL_LIFECYCLE,
    checklist,
    milestones,
    clientRequests,
    deliverables,
    findingCategories,
    closureRequirements: COMMON_CLOSURE_REQUIREMENTS,
    safetyBoundaries: [
      "No professional opinion or conclusion is generated automatically.",
      "No portal filing or submission is performed automatically.",
      "All findings, responses, deliverables, and closure decisions require human review.",
      ...safetyBoundaries,
    ],
  };
}

const ENGAGEMENT_TEMPLATES = {
  STATUTORY_AUDIT: defineTemplate({
    engagementType: "STATUTORY_AUDIT",
    title: "Statutory Audit",
    purpose: "Plan, perform, review, deliver, and close a statutory audit engagement without generating an audit opinion.",
    checklist: [
      item("acceptance", "Acceptance and continuance", "INTAKE"),
      item("independence", "Independence and conflict confirmation", "INTAKE"),
      item("scope_materiality", "Scope and materiality record", "SCOPE"),
      item("risk_register", "Risk register", "PLANNING"),
      item("audit_program", "Audit program by area", "FIELDWORK"),
      item("sampling_metadata", "Sampling record metadata", "FIELDWORK"),
      item("queries_responses", "Queries and client responses", "RESPONSE"),
      item("misstatements", "Misstatement and findings register", "REVIEW"),
      item("completion", "Completion checklist", "CLOSURE"),
    ],
    milestones: [
      item("planning_complete", "Planning complete", "PLANNING"),
      item("fieldwork_complete", "Fieldwork complete", "FIELDWORK"),
      item("review_complete", "Review complete", "REVIEW"),
      item("engagement_closed", "Engagement closed", "CLOSURE"),
    ],
    clientRequests: [
      item("pbc", "Prepared-by-client document request", "PLANNING"),
      item("management_responses", "Management responses to findings", "RESPONSE"),
      item("representations", "Management representation reference", "DELIVERY"),
    ],
    deliverables: [
      item("financial_statements", "Financial statement reference", "DELIVERY"),
      item("audit_report", "Human-approved audit report record", "DELIVERY"),
      item("management_letter", "Management letter record", "DELIVERY", false),
    ],
    findingCategories: ["CONTROL", "MISSTATEMENT", "DISCLOSURE", "COMPLIANCE", "OTHER"],
    safetyBoundaries: ["Audit opinion wording and signing remain outside automated generation."],
  }),
  INTERNAL_AUDIT: defineTemplate({
    engagementType: "INTERNAL_AUDIT",
    title: "Internal Audit",
    purpose: "Track scope, fieldwork, findings, management responses, actions, follow-up, review, and closure.",
    checklist: [
      item("scope_process", "Scope, location, and process confirmation", "SCOPE"),
      item("audit_program", "Internal audit program", "PLANNING"),
      item("fieldwork", "Fieldwork procedures", "FIELDWORK"),
      item("evidence", "Evidence references", "FIELDWORK"),
      item("findings", "Findings and risk classification", "RESPONSE"),
      item("follow_up", "Follow-up verification", "REVIEW"),
    ],
    milestones: [
      item("kickoff", "Kickoff complete", "PLANNING"),
      item("fieldwork_complete", "Fieldwork complete", "FIELDWORK"),
      item("management_response_complete", "Management responses complete", "RESPONSE"),
      item("follow_up_complete", "Follow-up complete", "CLOSURE"),
    ],
    clientRequests: [
      item("process_documents", "Process and control documents", "PLANNING"),
      item("management_responses", "Management response and action plan", "RESPONSE"),
    ],
    deliverables: [
      item("draft_report", "Draft internal audit report", "REVIEW"),
      item("final_report", "Human-approved final report", "DELIVERY"),
      item("closure_dashboard", "Open and closed finding summary", "CLOSURE"),
    ],
    findingCategories: ["CONTROL", "PROCESS", "COMPLIANCE", "FINANCIAL", "OPERATIONAL", "OTHER"],
  }),
  STOCK_AUDIT: defineTemplate({
    engagementType: "STOCK_AUDIT",
    title: "Stock Audit",
    purpose: "Coordinate site work, physical verification, source records, observations, responses, review, and report delivery.",
    checklist: [
      item("site_scope", "Site, borrower, and scope details", "SCOPE"),
      item("visit_schedule", "Visit schedule", "PLANNING"),
      item("physical_verification", "Physical verification checklist", "FIELDWORK"),
      item("stock_observations", "Stock, debtor, and creditor observations", "FIELDWORK"),
      item("exceptions", "Exception and evidence register", "RESPONSE"),
      item("response_review", "Management response review", "REVIEW"),
    ],
    milestones: [
      item("documents_ready", "Required statements ready", "PLANNING"),
      item("visit_complete", "Site visit complete", "FIELDWORK"),
      item("exceptions_reviewed", "Exceptions reviewed", "REVIEW"),
      item("report_approved", "Report approved", "DELIVERY"),
    ],
    clientRequests: [
      item("stock_statements", "Stock statements and inventory records", "PLANNING"),
      item("debtors_creditors", "Debtor and creditor records", "PLANNING"),
      item("management_response", "Management response", "RESPONSE"),
    ],
    deliverables: [
      item("visit_record", "Visit and physical verification record", "FIELDWORK"),
      item("stock_report", "Human-approved stock audit report", "DELIVERY"),
    ],
    findingCategories: ["STOCK", "DEBTOR", "CREDITOR", "VALUATION", "CONTROL", "OTHER"],
    safetyBoundaries: ["Values and drawing-power inputs remain reviewed estimates unless source and rule are confirmed."],
  }),
  BANK_AUDIT: defineTemplate({
    engagementType: "BANK_AUDIT",
    title: "Bank Audit",
    purpose: "Coordinate branch scope, source statements, procedures, exceptions, responses, review, and report delivery.",
    checklist: [
      item("branch_scope", "Branch, borrower, and scope details", "SCOPE"),
      item("visit_schedule", "Branch or site visit schedule", "PLANNING"),
      item("document_review", "Required statement and document review", "FIELDWORK"),
      item("drawing_power", "Drawing-power input worksheet metadata", "FIELDWORK"),
      item("exceptions", "Exception and evidence register", "RESPONSE"),
      item("branch_response", "Branch response review", "REVIEW"),
    ],
    milestones: [
      item("planning_complete", "Planning complete", "PLANNING"),
      item("verification_complete", "Verification complete", "FIELDWORK"),
      item("responses_complete", "Responses complete", "RESPONSE"),
      item("report_approved", "Report approved", "DELIVERY"),
    ],
    clientRequests: [
      item("borrower_records", "Borrower and facility records", "PLANNING"),
      item("security_records", "Security and statement records", "PLANNING"),
      item("branch_response", "Branch or management response", "RESPONSE"),
    ],
    deliverables: [
      item("exception_summary", "Reviewed exception summary", "REVIEW"),
      item("bank_report", "Human-approved bank audit report", "DELIVERY"),
    ],
    findingCategories: ["FACILITY", "SECURITY", "DOCUMENTATION", "DRAWING_POWER", "CONTROL", "OTHER"],
    safetyBoundaries: ["Drawing-power and other computations remain reviewed estimates until source and method are confirmed."],
  }),
  TAX_ADVISORY: defineTemplate({
    engagementType: "TAX_ADVISORY",
    title: "Tax Advisory",
    purpose: "Preserve supplied facts, assumptions, information gaps, options, reviewed advice, client decisions, and follow-up.",
    checklist: [
      item("question", "Question or issue", "INTAKE"),
      item("facts", "Facts supplied", "SCOPE"),
      item("assumptions", "Assumptions and information gaps", "SCOPE"),
      item("options", "Options considered", "FIELDWORK"),
      item("computations", "Computation attachment or reference", "FIELDWORK", false),
      item("recommendation_review", "Recommendation draft review", "REVIEW"),
      item("client_decision", "Client decision record", "RESPONSE"),
    ],
    milestones: [
      item("facts_confirmed", "Facts and assumptions confirmed", "SCOPE"),
      item("options_reviewed", "Options reviewed", "REVIEW"),
      item("client_decision_recorded", "Client decision recorded", "DELIVERY"),
      item("follow_up_complete", "Follow-up complete", "CLOSURE"),
    ],
    clientRequests: [
      item("facts_documents", "Facts and supporting information", "SCOPE"),
      item("decision", "Client decision or instruction", "RESPONSE"),
    ],
    deliverables: [
      item("advice_draft", "Advice draft", "REVIEW"),
      item("final_advice", "Human-approved final advice record", "DELIVERY"),
    ],
    findingCategories: ["INFORMATION_GAP", "ASSUMPTION", "OPTION", "RISK", "FOLLOW_UP", "OTHER"],
    safetyBoundaries: ["The platform records advice workflow but does not make a tax recommendation or legal conclusion."],
  }),
  DUE_DILIGENCE: defineTemplate({
    engagementType: "DUE_DILIGENCE",
    title: "Due Diligence",
    purpose: "Track workstreams, information requests, Q&A, red flags, responses, review, reporting, and open items at closing.",
    checklist: [
      item("scope_workstreams", "Scope and workstreams", "SCOPE"),
      item("data_room", "Data-room reference register", "PLANNING"),
      item("qa_tracker", "Question and answer tracker", "FIELDWORK"),
      item("findings", "Findings and red flags", "RESPONSE"),
      item("materiality", "Materiality and severity review", "REVIEW"),
      item("open_items", "Open items at closing", "CLOSURE"),
    ],
    milestones: [
      item("request_list_issued", "Information request list issued", "PLANNING"),
      item("fieldwork_complete", "Workstreams complete", "FIELDWORK"),
      item("red_flags_reviewed", "Red flags reviewed", "REVIEW"),
      item("closing_items_recorded", "Closing items recorded", "CLOSURE"),
    ],
    clientRequests: [
      item("information_request", "Information request list", "PLANNING"),
      item("qa_responses", "Q&A responses", "RESPONSE"),
      item("management_response", "Management response to findings", "RESPONSE"),
    ],
    deliverables: [
      item("red_flag_summary", "Reviewed red-flag summary", "REVIEW"),
      item("dd_report", "Human-approved due diligence report", "DELIVERY"),
      item("closing_open_items", "Open-items-at-closing record", "CLOSURE"),
    ],
    findingCategories: ["FINANCIAL", "TAX", "LEGAL_REFERENCE", "COMMERCIAL", "CONTROL", "RED_FLAG", "OTHER"],
  }),
  SECRETARIAL_COMPLIANCE: defineTemplate({
    engagementType: "SECRETARIAL_COMPLIANCE",
    title: "Secretarial Compliance",
    purpose: "Coordinate entity milestones, records, action items, filing acknowledgments, review, and closure without portal filing.",
    checklist: [
      item("entity_calendar", "Entity-specific compliance calendar", "PLANNING"),
      item("meeting_milestones", "Board, committee, and AGM milestones", "PLANNING"),
      item("agenda_documents", "Agenda and document checklist", "FIELDWORK"),
      item("minutes_actions", "Minutes and action-item tracking", "RESPONSE"),
      item("director_kmp", "Director and KMP compliance checklist", "FIELDWORK"),
      item("registers_disclosures", "Registers and disclosure checklist", "FIELDWORK"),
      item("filing_acknowledgments", "Filing acknowledgment record", "DELIVERY"),
    ],
    milestones: [
      item("calendar_confirmed", "Calendar confirmed", "PLANNING"),
      item("meeting_actions_complete", "Meeting actions complete", "RESPONSE"),
      item("filings_reviewed", "Filing records reviewed", "REVIEW"),
      item("period_closed", "Period closed", "CLOSURE"),
    ],
    clientRequests: [
      item("corporate_records", "Corporate records and disclosures", "PLANNING"),
      item("minutes_approvals", "Minutes and approval records", "RESPONSE"),
      item("filing_evidence", "User-supplied filing acknowledgments", "DELIVERY"),
    ],
    deliverables: [
      item("compliance_summary", "Human-reviewed compliance summary", "DELIVERY"),
      item("acknowledgment_index", "Filing acknowledgment index", "DELIVERY"),
    ],
    findingCategories: ["CALENDAR", "MEETING", "REGISTER", "DISCLOSURE", "FILING_RECORD", "OTHER"],
    safetyBoundaries: ["This template supports workflow only. It does not draft or submit secretarial filings."],
  }),
  FORENSIC_AUDIT: defineTemplate({
    engagementType: "FORENSIC_AUDIT",
    title: "Forensic Audit",
    purpose: "Support an authorized investigation through evidence references, custody events, procedures, findings, review, reporting, and retention decisions.",
    checklist: [
      item("authorization", "Investigation authorization and scope", "INTAKE"),
      item("authorized_team", "Authorized team confirmation", "SCOPE"),
      item("evidence_register", "Evidence register and hashes", "FIELDWORK"),
      item("custody", "Chain-of-custody event references", "FIELDWORK"),
      item("interviews", "Interview schedule and notes metadata", "FIELDWORK", false),
      item("procedures", "Procedures performed", "FIELDWORK"),
      item("legal_sensitivity", "Legal sensitivity markers", "REVIEW"),
      item("retention", "Closure and retention decision", "CLOSURE"),
    ],
    milestones: [
      item("authorization_confirmed", "Authorization confirmed", "INTAKE"),
      item("evidence_preserved", "Evidence references preserved", "FIELDWORK"),
      item("findings_reviewed", "Findings reviewed", "REVIEW"),
      item("retention_recorded", "Retention decision recorded", "CLOSURE"),
    ],
    clientRequests: [
      item("authorization_record", "Authorization record", "INTAKE"),
      item("evidence_access", "Authorized evidence access references", "FIELDWORK"),
      item("management_response", "Management response where appropriate", "RESPONSE", false),
    ],
    deliverables: [
      item("findings_report", "Human-approved forensic findings report", "DELIVERY"),
      item("retention_record", "Retention and deletion decision record", "CLOSURE"),
    ],
    findingCategories: ["EVIDENCE", "CONTROL", "TRANSACTION", "INTERVIEW", "LEGAL_SENSITIVITY", "OTHER"],
    safetyBoundaries: [
      "No unrestricted surveillance or covert collection is supported.",
      "Binary evidence storage is not provided by this engagement record.",
    ],
  }),
  GST_ASSESSMENT: defineTemplate({
    engagementType: "GST_ASSESSMENT",
    title: "GST Assessment Support",
    purpose: "Coordinate assessment scope, source-linked case work, reconciliation support, response records, review, outcome, and follow-up.",
    checklist: [
      item("case_link", "Linked GST CaseMatter confirmation", "INTAKE"),
      item("issues", "Assessment issues and periods", "SCOPE"),
      item("reconciliations", "Reconciliation references", "FIELDWORK"),
      item("document_index", "Supporting document index", "FIELDWORK"),
      item("responses", "Reply and hearing record references", "RESPONSE"),
      item("outcome", "Order and next-step review", "CLOSURE"),
    ],
    milestones: [
      item("scope_confirmed", "Assessment scope confirmed", "SCOPE"),
      item("support_complete", "Supporting work complete", "FIELDWORK"),
      item("response_reviewed", "Response record reviewed", "REVIEW"),
      item("outcome_recorded", "Outcome recorded", "CLOSURE"),
    ],
    clientRequests: [
      item("assessment_documents", "Assessment documents and explanations", "PLANNING"),
      item("response_approval", "Client response or approval record", "RESPONSE"),
    ],
    deliverables: [
      item("supporting_index", "Supporting document index", "DELIVERY"),
      item("response_record", "Human-approved response record reference", "DELIVERY"),
      item("outcome_summary", "Factual outcome and next-step summary", "CLOSURE"),
    ],
    findingCategories: ["NOTICE_ISSUE", "RECONCILIATION", "DOCUMENT_GAP", "RESPONSE_POINT", "FOLLOW_UP", "OTHER"],
    safetyBoundaries: ["Notice, hearing, submission, and order facts remain authoritative in linked CaseMatter records."],
  }),
  GST_REFUND: defineTemplate({
    engagementType: "GST_REFUND",
    title: "GST Refund Support",
    purpose: "Coordinate refund checklist, source-linked case records, deficiencies, reconciliations, evidence, review, outcome, and follow-up.",
    checklist: [
      item("case_link", "Linked GST refund CaseMatter confirmation", "INTAKE"),
      item("refund_scope", "Refund category, period, and scope", "SCOPE"),
      item("application_checklist", "Refund application checklist", "PLANNING"),
      item("reconciliations", "Reconciliation references", "FIELDWORK"),
      item("document_index", "Supporting document index", "FIELDWORK"),
      item("deficiency_response", "Deficiency memo response reference", "RESPONSE", false),
      item("outcome", "Refund outcome and next-step review", "CLOSURE"),
    ],
    milestones: [
      item("eligibility_inputs_confirmed", "Eligibility inputs confirmed by user", "SCOPE"),
      item("application_support_complete", "Application support complete", "FIELDWORK"),
      item("response_reviewed", "Response records reviewed", "REVIEW"),
      item("outcome_recorded", "Refund outcome recorded", "CLOSURE"),
    ],
    clientRequests: [
      item("refund_documents", "Refund supporting records", "PLANNING"),
      item("deficiency_inputs", "Deficiency response inputs", "RESPONSE", false),
      item("portal_evidence", "User-supplied portal acknowledgment or order", "DELIVERY"),
    ],
    deliverables: [
      item("application_index", "Application support index", "DELIVERY"),
      item("response_record", "Human-approved deficiency response record", "DELIVERY", false),
      item("outcome_summary", "Factual refund outcome summary", "CLOSURE"),
    ],
    findingCategories: ["DOCUMENT_GAP", "RECONCILIATION", "DEFICIENCY", "RESPONSE_POINT", "FOLLOW_UP", "OTHER"],
    safetyBoundaries: ["Refund eligibility and portal submission remain professional and user-controlled decisions."],
  }),
  GST_AUDIT: defineTemplate({
    engagementType: "GST_AUDIT",
    title: "GST Audit Support",
    purpose: "Coordinate GST audit scope, case links, reconciliations, evidence, queries, responses, review, outcome, and follow-up.",
    checklist: [
      item("case_link", "Linked GST audit CaseMatter confirmation", "INTAKE"),
      item("audit_scope", "Audit periods and scope", "SCOPE"),
      item("reconciliations", "GST reconciliation references", "FIELDWORK"),
      item("document_index", "Supporting document index", "FIELDWORK"),
      item("queries", "Query and response references", "RESPONSE"),
      item("outcome", "Audit outcome and next-step review", "CLOSURE"),
    ],
    milestones: [
      item("scope_confirmed", "Audit scope confirmed", "SCOPE"),
      item("evidence_complete", "Evidence support complete", "FIELDWORK"),
      item("responses_reviewed", "Responses reviewed", "REVIEW"),
      item("outcome_recorded", "Outcome recorded", "CLOSURE"),
    ],
    clientRequests: [
      item("audit_documents", "GST audit records and explanations", "PLANNING"),
      item("query_responses", "Client inputs for audit queries", "RESPONSE"),
    ],
    deliverables: [
      item("supporting_index", "Supporting document index", "DELIVERY"),
      item("response_record", "Human-approved response record", "DELIVERY"),
      item("outcome_summary", "Factual outcome and next-step summary", "CLOSURE"),
    ],
    findingCategories: ["RECONCILIATION", "DOCUMENT_GAP", "QUERY", "RESPONSE_POINT", "FOLLOW_UP", "OTHER"],
    safetyBoundaries: ["Portal filing, legal conclusions, and professional determinations are not automated."],
  }),
};

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

deepFreeze(ENGAGEMENT_TEMPLATES);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function getEngagementTemplate(engagementType) {
  const key = String(engagementType || "").trim().toUpperCase();
  return ENGAGEMENT_TEMPLATES[key] ? clone(ENGAGEMENT_TEMPLATES[key]) : null;
}

function listEngagementTemplates() {
  return ENGAGEMENT_TYPES.map((engagementType) => {
    const template = ENGAGEMENT_TEMPLATES[engagementType];
    return {
      templateId: template.templateId,
      version: template.version,
      engagementType,
      title: template.title,
      purpose: template.purpose,
      catalogReviewState: template.catalogReviewState,
      lifecycleCapabilities: template.lifecycleCoverage.map((entry) => entry.capability),
      componentCounts: {
        checklist: template.checklist.length,
        milestones: template.milestones.length,
        clientRequests: template.clientRequests.length,
        deliverables: template.deliverables.length,
      },
      safetyBoundaries: [...template.safetyBoundaries],
    };
  });
}

export {
  ENGAGEMENT_STATUSES,
  ENGAGEMENT_TEMPLATES,
  ENGAGEMENT_TYPES,
  FULL_LIFECYCLE,
  getEngagementTemplate,
  listEngagementTemplates,
};
