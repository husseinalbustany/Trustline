import type { PdfWording } from './types.js';

/** Word for word as the web's print view (dictionaries, `policies.document`, `policies.imported`, `policies.notInForce`). */
export const en: PdfWording = {
  "dir": "ltr",
  "languages": {
    "en": "English",
    "ar": "Arabic",
    "fr": "French"
  },
  "controlBlock": "Controlled document",
  "number": "Number",
  "version": "Version",
  "title": "Title",
  "owner": "Owner",
  "ownerUnit": "Responsible area",
  "effectiveOn": "In force from",
  "nextReviewOn": "Next review",
  "authoritative": "Language that applies",
  "approvals": "Prepared, reviewed and approved",
  "noApprovals": "No signature yet.",
  "preparedBy": "Prepared by {name} on {date}",
  "reviewedBy": "Reviewed by {name} on {date}",
  "approvedBy": "Approved by {name} on {date}",
  "notSet": "Not set",
  "unknownPerson": "A former user",
  "notControlled": "Printed copies are not controlled. Check Trustline for the current version.",
  "printHeader": "{number} · Version {version} · {title}",
  "printHeaderOriginal": "{number} · Version {version} ({revision} on the original) · {title}",
  "printedOn": "Printed on {date}, valid on that day only.",
  "pageOf": "Page {page} of {pages}",
  "sectionInOther": "This section is not written in {language}. It is shown here in {other}.",
  "sectionLagging": "This section was not updated in {language} after the {authoritative} text changed. Where they differ, the {authoritative} text applies.",
  "notInForce": {
    "retired": "Retired, not in force",
    "superseded": "Superseded, not in force",
    "withdrawn": "Withdrawn, never in force",
    "unpublished": "Not published, not in force"
  },
  "imported": {
    "title": "Approved before Trustline",
    "notThroughRoute": "Entered from its signed original. It did not go through Trustline's approval route; it is re-issued through the route at its next review.",
    "revisionLabel": "Revision",
    "approvedOn": "Approved on",
    "approvedBy": "Approved by (as written on the original)",
    "originalKeptAt": "Signed original kept at",
    "differences": "Differences from the original"
  },
  "contentHash": "Fingerprint of the signed text (SHA-256)",
  "aiDraft": "AI draft",
  "aiNotice": "Written by an AI assistant. It can be wrong or incomplete: check every part against how your organization works before you rely on it. Only a person can approve or publish what it writes."
};
