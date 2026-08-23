import { createHash } from "node:crypto";

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

const termsDocument = {
  version: "2026-08-23",
  effectiveDate: "2026-08-23",
  title: "Terms & Conditions",
  summary:
    "Review these terms before signing in. CA PRO Toolkit supports professional review and organisation; it does not file, submit, approve, or replace professional judgment.",
  privacyUrl: "https://caprotoolkit.in/privacy.html",
  sections: [
    {
      heading: "1. Acceptance of terms",
      paragraphs: [
        "These Terms & Conditions (\"Terms\") form an agreement between you and Saifullah Faizan, sole proprietor, trading as CA PRO Toolkit (\"we\", \"us\", \"our\") governing your use of the CA PRO Toolkit Windows desktop application, browser extension, workspace and Web View, tool pages, and backend services (together, the \"Service\"). If you do not agree, do not use the Service.",
        "That sole proprietorship is the contracting party under these Terms. No other person or company is a party to them.",
      ],
      bullets: [],
    },
    {
      heading: "2. The Service",
      paragraphs: [
        "CA PRO Toolkit helps Chartered Accountant firms organise and review audit, GST, TDS, notices, engagements, tasks, deadlines, and related work. The Service assists professional review and organisation. It does not file returns, submit anything to a government portal, scrape portals, or silently approve or close professional work.",
      ],
      bullets: [],
    },
    {
      heading: "3. Accounts, eligibility, and firms",
      paragraphs: [],
      bullets: [
        "You must sign in with a valid account and are responsible for keeping your access secure.",
        "You must be authorised to use the Service on behalf of your firm and its clients.",
        "Firm owners and administrators control roles, membership, and access within a shared firm. Invite codes should be shared only with people you authorise.",
        "You are responsible for activity under your account and for the accuracy of data you enter.",
      ],
    },
    {
      heading: "4. Acceptable use",
      paragraphs: ["You agree not to:"],
      bullets: [
        "Use the Service unlawfully or in breach of an applicable regulation or professional obligation.",
        "Upload content you are not authorised to process or infringe the rights of a third party.",
        "Attempt to disrupt, reverse engineer, overload, or gain unauthorised access to the Service or its infrastructure.",
        "Misuse AI or OCR features or submit content without the necessary authority or consent.",
      ],
    },
    {
      heading: "5. Professional and AI disclaimer",
      paragraphs: [
        "The Service is a support tool, not a substitute for professional judgment. Outputs, including AI-assisted classifications, standard mappings, matches, and insights, are informational and may be incomplete or inaccurate. You remain responsible for verifying results, confirming facts, and making all professional conclusions, filings, and advice. Nothing in the Service constitutes legal, tax, accounting, or other professional advice.",
      ],
      bullets: [],
    },
    {
      heading: "6. Content and data",
      paragraphs: [
        "You retain ownership of the data and content you submit. You grant us the limited rights needed to operate the Service, such as storing, processing, and displaying your content to you and your authorised firm members. Our handling of personal data is described in the Privacy Policy.",
      ],
      bullets: [],
    },
    {
      heading: "7. Intellectual property",
      paragraphs: [
        "The Service, including its software, design, branding, and content excluding your data, is owned by us and protected by applicable laws. You receive a limited, non-exclusive, non-transferable right to use the Service under these Terms. You may not copy, resell, or create derivative products from the Service without permission.",
      ],
      bullets: [],
    },
    {
      heading: "8. Third-party services",
      paragraphs: [
        "The Service relies on third parties such as Google Sign-In, email delivery, AI and OCR providers, and hosting providers. Your use of those features may also be subject to the relevant third party's terms. We are not responsible for third-party services outside our control.",
      ],
      bullets: [],
    },
    {
      heading: "9. Free access",
      paragraphs: [
        "The Service is offered free to use. There are no subscription fees or payment-conditioned product features in the current Service.",
      ],
      bullets: [],
    },
    {
      heading: "10. Availability and changes",
      paragraphs: [
        "We aim to keep the Service available and reliable, but availability is not guaranteed. We may modify, suspend, discontinue, or maintain features. We will not describe an unavailable or incomplete capability as completed.",
      ],
      bullets: [],
    },
    {
      heading: "11. Disclaimers and limitation of liability",
      paragraphs: [
        "The Service is provided \"as is\" and \"as available\" without warranties of any kind, express or implied, including fitness for a particular purpose and non-infringement. To the maximum extent permitted by law, we are not liable for indirect, incidental, special, consequential, or punitive damages, or for loss of data, profits, or professional consequences arising from your use of or reliance on the Service. Our total liability for a claim relating to the Service will not exceed the amount you paid us for the Service in the twelve months before the claim, which may be zero for free use.",
      ],
      bullets: [],
    },
    {
      heading: "12. Indemnity",
      paragraphs: [
        "You agree to indemnify and hold us harmless from claims, losses, and expenses arising from your misuse of the Service, your content, or your breach of these Terms or an applicable law or professional obligation.",
      ],
      bullets: [],
    },
    {
      heading: "13. Termination",
      paragraphs: [
        "You may stop using the Service at any time. We may suspend or terminate access if you breach these Terms or misuse the Service. Provisions that by their nature should survive termination will continue to apply.",
      ],
      bullets: [],
    },
    {
      heading: "14. Governing law",
      paragraphs: [
        "These Terms are governed by the laws of India. The courts at Kolkata will have exclusive jurisdiction, subject to any mandatory consumer-protection rights that apply to you and cannot be excluded by agreement.",
      ],
      bullets: [],
    },
    {
      heading: "15. Changes to these Terms",
      paragraphs: [
        "We may update these Terms from time to time. A material update will use a new version and effective date. When renewed acceptance is required, the Service will ask you to review and accept the updated Terms before continuing.",
      ],
      bullets: [],
    },
    {
      heading: "16. Contact",
      paragraphs: [
        "Questions about these Terms may be sent to support@caprotoolkit.in. See the Privacy Policy for information about personal-data handling, and section 17 below for the grievance route under the Digital Personal Data Protection Act, 2023.",
      ],
      bullets: [],
    },
    {
      heading: "17. Grievance officer",
      paragraphs: [
        "Under section 13 of the Digital Personal Data Protection Act, 2023, you may raise any question or complaint about how your personal data is handled with the grievance officer named below. This includes asking what data is held about you, asking for a correction, or asking for erasure.",
        "You will receive a substantive answer within 30 days. If you are not satisfied with the response, the Act allows you to complain to the Data Protection Board of India.",
      ],
      bullets: [
        "Grievance officer: Saifullah Faizan",
        "Designation: Proprietor",
        "Email: support@caprotoolkit.in",
        "Response window: 30 days",
        "Postal address: published in the Privacy Policy at https://caprotoolkit.in/privacy.html",
      ],
    },
  ],
};

const documentHash = createHash("sha256")
  .update(JSON.stringify(termsDocument), "utf8")
  .digest("hex");

export const CURRENT_TERMS = deepFreeze({ ...termsDocument, documentHash });
