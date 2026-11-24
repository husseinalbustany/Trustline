> Converted from the business requirements document (v0.1, 19 November 2026).
> Decisions taken since it was written:
> - AI features are not in the first release; they will be revisited later.
> - There are two pilots, one surveyed by JCI and one by CBAHI.
> - The launch region is not fixed; Lebanon is under discussion.
> - Single sign-on is offered only to clients who ask; others use a login page.
> - The product works in any languages a client chooses (English, Arabic and French today), not only English and Arabic.

# Trustline Business Requirements & Approval

Nov 19, 2026 · @Hussein Al Bustany

## Purpose and decision requested

Business is asked to approve **Trustline** as a new product line, the scope of its first sellable release (MVP), and the open decisions listed under "Decisions required from business".

- **Product name:** Trustline (one line of trust from the moment a concern is reported to its resolution, and from policy to proof that staff were trained). Working name until trademark and domain checks are done.

- **Status:** Draft for business review (v0.1)

- **Prepared by:** Technology (Tech Lead)

- **Companion document:** the full technical build specification (TRUSTLINE_SPEC.md)

- **Approval means:** engineering starts the Foundation phase and MVP; sales and pre-sales start conversations with pilot hospitals.

## Executive summary

Trustline is an AI-assisted Quality, Risk and Incident Management platform for hospitals and large organizations, sold as SaaS to SMEs and as a dedicated single-tenant deployment to enterprises.

It replaces paper forms, spreadsheets and disconnected tools with one platform covering:

1.  **Policies & procedures** with configurable approval cycles, e-signatures and an AI drafting assistant

2.  **Incident, near-miss and hazard reporting** that any employee can use in under 2 minutes, from any device or from inside the systems they already use (SSO)

3.  **Investigation and root cause analysis (RCA)** with structured tools and final reports

4.  **Risk management** with risk registers and a 5×5 risk matrix

5.  **Actions (CAPA)**, one tracker for every corrective and preventive action

6.  **Reporting and analytics** with role-based dashboards, charts and scheduled reports; plus training & awareness, where staff sign to confirm each training they receive

The market is large and growing: healthcare quality management is estimated at USD 2.78 billion in 2026, rising to USD 5.46 billion by 2034 ([Fortune Business Insights](https://www.fortunebusinessinsights.com/healthcare-quality-management-market-114766)). Our edge in MENA: Arabic-first design, in-country hosting, an AI-native product and flexible deployment, against global competitors that are heavier, older platforms.

## Problem and opportunity

Hospitals must prove to accreditors (JCI, CBAHI) that they control documents, learn from incidents and manage risk, yet many still rely on paper, email and Excel.

- **Fragmented reporting:** Saudi Arabia's Eastern Health Cluster (22 hospitals, 24,000+ staff) cited inconsistent reporting across facilities and paper-based legacy systems as the reason for moving to one unified safety reporting system ([Saudi Patient Safety Center presentation](https://sqc.org.sa/wp-content/uploads/2025/10/%D8%AD%D9%88%D8%A7%D8%B1-%D8%B5%D8%B1%D9%8A%D8%AD-%D9%88%D8%B6%D8%B9-%D8%A7%D9%84%D8%B3%D9%84%D8%A7%D9%85%D8%A9-%D9%81%D9%8A-%D9%82%D9%84%D8%A8-%D8%B9%D9%85%D9%84%D9%8A%D8%A9-%D8%A7%D9%84%D8%A5%D8%B5%D9%84%D8%A7%D8%AD-%D8%A7%D9%84%D8%B5%D8%AD%D9%8A-%D8%A3.-%D8%A3%D8%B3%D8%B9%D8%AF-%D8%AE%D9%84%D9%8A%D9%84.pdf)).

- **Ease of use drives reporting:** after a Riyadh teaching hospital moved to electronic occurrence reporting, reports rose 33.6%; the study concluded systems must be simple, accessible and guarantee anonymity ([Abu Alrub et al., 2022](https://experts.mcmaster.ca/display/publication2141836)).

- **Volume overwhelms quality teams:** Pennsylvania's state system received 315,418 reports in 2024, up 9.5%, and manual triage struggles to keep up ([Origami Risk](https://www.origamirisk.com/?p=21238)).

- **Weak follow-through:** a study cited in the same article found 76% of corrective actions were low-leverage and only 8% high-leverage.

Trustline answers each point: frictionless reporting from anywhere, AI-assisted triage, structured RCA, and an action tracker that checks whether actions actually worked.

## Market research and competitive landscape

The category is established and growing, led by a few global vendors; none presents itself as Arabic-first or built around MENA data-residency rules.

| Indicator                                                 | Figure                         | Source                                                                                                                                       |
|-----------------------------------------------------------|--------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------|
| Healthcare quality management market, 2026                | USD 2.78 bn                    | [Fortune Business Insights](https://www.fortunebusinessinsights.com/healthcare-quality-management-market-114766)                             |
| Same market, 2034 projection                              | USD 5.46 bn (8.78% CAGR)       | [Fortune Business Insights](https://www.fortunebusinessinsights.com/healthcare-quality-management-market-114766)                             |
| Healthcare safety & risk management solutions, 2026       | USD 2.6 bn, 10.4% CAGR to 2033 | [Persistence Market Research](https://www.persistencemarketresearch.com/mediarelease/healthcare-safety-risk-management-solutions-market.asp) |
| Incident reporting share of patient-safety software, 2026 | 26.8%, the largest segment     | [Coherent MI](https://coherentmi.com/industry-reports/patient-safety-and-risk-management-software-market)                                    |

Estimates differ by research firm; all show high single to low double-digit growth.

| Competitor                                                          | Position                                                                                                                 | Offer                                                     | Gap Trustline can exploit                                          |
|---------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------|-----------------------------------------------------------|--------------------------------------------------------------------|
| [RLDatix (Datix Cloud IQ, PolicyStat)](https://rldatix.com/en-mea/) | Global leader; in KSA/UAE (Abu Dhabi DoH, Johns Hopkins Aramco)                                                          | Incidents, enterprise risk, policy, accreditation         | Enterprise-priced and heavy; Arabic support not clearly advertised |
| [MEG](https://megsupporttools.com)                                  | Cloud QMS in 30+ countries, Middle East customers                                                                        | Audits, incidents, documents, feedback, JCI accreditation | Audit-led; less depth in RCA and enterprise risk                   |
| [Origami Risk](https://www.origamirisk.com/risk/healthcare)         | US risk-management (RMIS) leader                                                                                         | Safety events, RCA, claims, AI triage                     | US-focused, insurance and claims oriented                          |
| Symplr, Riskonnect, Radar Healthcare, Ideagen                       | Named market players ([Fortune BI](https://www.fortunebusinessinsights.com/healthcare-quality-management-market-114766)) | Safety, quality and compliance suites                     | Little local presence or Arabic-first UX                           |
| Local / in-house OVR systems                                        | Common in KSA public hospitals                                                                                           | Basic occurrence variance reports                         | No RCA, risk, CAPA or analytics; hard to scale across clusters     |

**What the research tells us to match:** mobile reporting, linking incidents to investigations and risks, configurable workflows, policy attestation and version control, risk-ranked triage, and AI-assisted reporting. **Where to win:** Arabic and RTL quality, in-Kingdom hosting, SSO into the client's existing systems, modern UX, and pricing that lets every employee report.

## Target customers and deployment model

One product and one codebase, deployed three ways.

| Segment                 | Examples                                                                         | Deployment                                                       | Why                                                                          |
|-------------------------|----------------------------------------------------------------------------------|------------------------------------------------------------------|------------------------------------------------------------------------------|
| SME                     | Clinics, small hospitals (under 200 beds), medical centers, labs                 | SaaS, shared                                                     | Low cost, fast onboarding, no IT needed                                      |
| Mid-market              | Hospitals of 200–500 beds, private groups                                        | SaaS, dedicated database                                         | Stronger data isolation, still fully managed by us                           |
| Enterprise / government | Health clusters, ministries, large hospital groups, large non-health enterprises | Single-tenant dedicated (our cloud, client cloud or on-premises) | Data residency, own security policies and encryption keys, deep integrations |

**Primary market:** hospitals in KSA, UAE and the wider GCC/MENA. **Secondary:** any large organization needing quality, incident and risk governance (manufacturing, aviation, banking, government).

## Solution scope: core modules

| Module                                 | Business outcome                                                       | Key capabilities                                                                                                                                                                           |
|----------------------------------------|------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Policies & procedures                  | One trusted library of current, approved documents                     | Templates, numbering, versioning, configurable approval cycles, e-signature, periodic review reminders, read-and-acknowledge with quizzes, bilingual PDF export                            |
| Incident, near-miss & hazard reporting | Every employee can raise a safety concern in under 2 minutes           | Mobile-friendly wizard, anonymous option, QR codes on locations and equipment, category-specific forms, severity and sentinel-event flags                                                  |
| Incident handling                      | Every report reaches the right people and closes on time               | Triage, routing to responsible departments, response deadlines with escalation, feedback to the reporter, regulator-reporting tracking                                                     |
| Investigation & RCA                    | Find the real cause, not a person to blame                             | Investigation team, timeline, interviews, evidence, 5 Whys, fishbone diagram, contributing factors, action-strength check, RCA report with approval                                        |
| Risk management                        | See and control the organization's top risks                           | Enterprise and department registers, configurable 5×5 matrix, controls, reviews, heat maps, incidents linked to risks                                                                      |
| Actions (CAPA)                         | Nothing agreed is forgotten, and we know whether it worked             | One tracker for all modules, owners, due dates, evidence, escalation, effectiveness checks                                                                                                 |
| Reporting & analytics                  | Leadership and committees see the facts                                | Role-based dashboards, trends, Pareto and control (SPC) charts, standard reports, report builder, scheduled email reports, Excel/PDF export                                                |
| Administration                         | Each client configures Trustline without custom code                   | Org structure, roles and permissions, workflow and form configuration, categories, branding, English/Arabic                                                                                |
| Training & awareness                   | Prove every employee was trained on what matters, with their signature | Courses and awareness campaigns, classroom and online sessions, attendance with e-signature, quizzes, certificates with expiry and renewal, training matrix by role, compliance dashboards |

Every action in the system is recorded in a tamper-evident audit trail, which accreditation surveyors and auditors can review.

### Training & awareness (new module)

Quality departments must show accreditors that staff were trained on policies, safety practices and lessons from incidents. Trustline keeps that proof in one place, linked to the policies and incidents that triggered it.

- **Training catalog:** mandatory and optional courses (e.g. fire safety, hand hygiene, infection control, patient identification, data privacy), each with owner, audience, duration and renewal period.

- **Delivery types:** classroom sessions, online courses (video, slides, documents), on-the-job sessions, and short awareness campaigns (posters, safety messages, micro-learning).

- **Training matrix:** required trainings by role, department and facility, assigned automatically when someone joins or changes role (from SSO/HR data).

- **Attendance and sign-off:** attendees sign that they received and understood the training, by e-signature, on a tablet at the session, or by scanning a session QR code; trainers sign that the session took place.

- **Assessment:** quizzes with pass marks, retakes, and AI-generated questions that the trainer approves.

- **Certificates and expiry:** auto-generated bilingual certificates; reminders before expiry; escalation to managers for overdue staff.

- **Linked to the rest of Trustline:** a new or changed policy can trigger a training or awareness campaign; an RCA or corrective action can assign targeted training; incident trends suggest where training is needed. The system still warns that training alone is a weak corrective action.

- **Compliance reporting:** % trained per department, overdue and expiring trainings, attendance records per employee, exportable as evidence for JCI/CBAHI surveys.

- **Integrations:** import or export records with an existing LMS or HR system (support for standard e-learning content in a later phase).

## SSO and integration with client systems

All staff must be able to report an incident or hazard from the systems they already use, with their existing login and no new password.

- **Single sign-on (SSO):** Microsoft Entra ID / Active Directory, ADFS, Okta, Google and other standard identity providers, using industry-standard protocols.

- **Automatic accounts:** an employee's first login creates their Trustline account as a Reporter, with department and role taken from the client's directory. No admin work for thousands of staff.

- **"Report" button inside other systems:** the client's intranet, hospital information system (HIS) or HR portal adds a button or widget that opens Trustline already logged in and pre-filled (location, department).

- **Inside the patient record:** launched from the EMR with the patient already filled in, so staff never retype details.

- **Microsoft Teams and email:** report, follow tasks and approve documents from Teams or email.

- **Contractors and visitors:** report via a one-time code (SMS/email), anonymously, or by scanning a QR code.

- **Two-way:** Trustline sends status updates back to the other system and can open a maintenance ticket in the facilities system when a hazard is reported.

Business implication: report-only users should be free or unlimited in pricing, so clients open reporting to all staff.

## AI capabilities and safeguards

AI saves the quality team time and improves report quality, but a person always makes the decision.

| Area               | AI helps by                                                                                                                                                                               |
|--------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Policies           | Drafting from a template, rewriting, English–Arabic translation, checking gaps against JCI/CBAHI requirements, finding conflicts between policies, generating summaries and staff quizzes |
| Staff questions    | An "Ask the policies" chat that answers only from approved documents, with references                                                                                                     |
| Incident reporting | Turning a typed or spoken description into a structured report; suggesting category, severity and location; flagging likely duplicates                                                    |
| Triage             | Ranking new reports by risk so serious events surface first                                                                                                                               |
| RCA                | Suggesting causes and contributing factors from the timeline; flagging weak actions such as "retrain staff"; drafting the RCA report                                                      |
| Analytics          | Answering plain-language questions ("falls by ward, last 6 months"); spotting unusual trends; drafting the monthly committee summary                                                      |

**Safeguards:** AI never approves, closes or publishes anything; all output is a suggestion. Patient identifiers are removed before text reaches an external AI service unless the client allows it. Each client can switch AI features off, or use a self-hosted model where external AI is not permitted. All AI use is logged.

This matches industry guidance that AI in safety event review should enhance human judgment, not replace it ([IHI](https://www.ihi.org/library/blog/potential-and-pitfalls-using-ai-safety-event-review)).

## Additional ideas and differentiators from research

These ideas come from competitor features, published studies and gaps seen in the MENA market. Business is asked to confirm which to keep and in which phase.

| Idea                                                    | Value to client                                                                                             | Inspiration                                                                                                                                                                                                    | Suggested phase |
|---------------------------------------------------------|-------------------------------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-----------------|
| WhatsApp and voice reporting (Arabic dialects)          | Staff report the way they already communicate; higher reporting rates                                       | Research shows ease of use raised reports 33.6% ([Abu Alrub et al.](https://experts.mcmaster.ca/display/publication2141836))                                                                                   | 2               |
| AI risk-ranked triage queue                             | Serious events reviewed first, not in arrival order                                                         | [Origami Risk](https://www.origamirisk.com/?p=21238)                                                                                                                                                           | 2               |
| Group similar incidents into one investigation          | One RCA for a pattern (e.g. 12 falls in one ward) instead of 12 small reviews                               | [Datix Cloud IQ release notes](https://elasticbeanstalk-us-east-1-420057813367.s3.amazonaws.com/Release_Notes/DCIQ/downloads/DCIQ.2025.R4.4_release_notes_US.pdf)                                              | 2               |
| Safety huddles                                          | Daily 10-minute unit huddles logged in the app, linked to open incidents and hazards                        | Riyadh hospital study of OVR plus safety huddles ([preprint](https://www.preprints.org/frontend/manuscript/3cbb08bfecf9400dffc527d8bc857997/download_pub))                                                     | 2               |
| Safety alerts and lessons-learned broadcast             | Push urgent alerts (outbreak, device recall) and learning summaries to targeted staff, with acknowledgement | [MEG mobile app](https://megsupporttools.com/meg-on-the-move-mobile-app)                                                                                                                                       | 1               |
| Accreditation readiness tracker                         | Self-assessment per JCI/CBAHI standard, evidence collection, readiness score, mock surveys                  | [MEG accreditation](https://megsupporttools.com/hospital-accreditation-mission-control)                                                                                                                        | 3               |
| Audits and inspections (mobile checklists)              | Ward rounds, hand-hygiene and environment audits; findings create actions automatically                     | [MEG](https://megsupporttools.com)                                                                                                                                                                             | 3               |
| Patient complaints and feedback                         | Complaints, compliments and response deadlines in the same platform as incidents                            | RLDatix and MEG both offer it                                                                                                                                                                                  | 3               |
| Open disclosure (communication with patient and family) | Tracks what was disclosed, when and by whom                                                                 | [Origami Risk CANDOR support](https://www.origamirisk.com/?p=18230)                                                                                                                                            | 2               |
| Automatic event detection from HIS data (trigger tools) | Finds harm that staff never reported (e.g. naloxone given, return to theatre)                               | [Leapfrog presentation](https://www.leapfroggroup.org/sites/default/files/Files/Leapfrog%20Presentation%20June%202025_Final%206.23%20V3-combined.pdf)                                                          | 4               |
| Health-cluster and ministry view                        | One dashboard and shared taxonomy across many hospitals, with benchmarking                                  | Abu Dhabi DoH unified safety taxonomy ([Mubasher](https://en.sharikatmubasher.com/news/article/21539260/rldatix-expands-middle-east-presence-through-healthcare-partnerships?lang=en)); Eastern Health Cluster | 3               |
| Mortality and morbidity (M&M) reviews                   | Structured case reviews linked to RCA and actions                                                           | [Fortune BI](https://www.fortunebusinessinsights.com/healthcare-quality-management-market-114766) lists M&M among core uses                                                                                    | 3               |
| "Good catch" recognition                                | Monthly recognition of near-miss reporters to build a just, non-punitive culture                            | Just-culture principle in the Riyadh study                                                                                                                                                                     | 1               |
| Second-victim support                                   | Offer follow-up support to staff involved in a serious incident                                             | Patient-safety good practice                                                                                                                                                                                   | 2               |
| KPI and quality-indicator management                    | Define indicators, targets and data entry; show on dashboards with control charts                           | Common in quality suites                                                                                                                                                                                       | 3               |
| Power BI connector                                      | Clients' BI teams use Trustline data in their own reports                                                   | [MEG API](https://www.applytosupply.digitalmarketplace.service.gov.uk/g-cloud/services/148255956586106)                                                                                                        | 3               |

## Compliance and standards alignment

Trustline helps clients comply; it does not certify them. The product itself must also pass hospital security and data-protection reviews.

| Area                  | Standards / rules                                                  | How Trustline supports it                                                       |
|-----------------------|--------------------------------------------------------------------|---------------------------------------------------------------------------------|
| Accreditation         | JCI, CBAHI, other GCC national standards                           | Document control, sentinel-event RCA, risk management, evidence and audit trail |
| Patient safety        | WHO patient-safety classification, NCC MERP medication-error index | Built-in incident taxonomy and harm scales                                      |
| Quality & risk        | ISO 9001, ISO 31000, ISO 45001, ISO 7101                           | Document control, corrective actions, risk process, staff-safety incidents      |
| Electronic signatures | 21 CFR Part 11 / EU Annex 11 style                                 | Re-authentication, signature meaning, timestamp, tamper-evident record          |
| Data protection       | Saudi PDPL, UAE PDPL, GDPR                                         | Data minimization, retention rules, anonymous reporting, regional hosting       |
| Platform security     | ISO 27001-aligned, SOC 2-ready                                     | Encryption, MFA, access controls, logging, penetration testing                  |

**Data residency is a sales requirement in KSA.** Saudi Ministry of Health guidance expects patient data to stay in the Kingdom ([MomentumX](https://momentumx.cloud/blog/mena-healthcare-cloud-compliance-architecture-2026/)), and SDAIA published draft PDPL amendments on 6 October 2026 that tighten transfers outside the Kingdom ([Gowling WLG](https://gowlingwlg.com/insights-resources/articles/2026/saudi-arabias-proposed-pdpl-amendments)). Trustline therefore needs an in-Kingdom hosting option at launch, and an AI option that keeps data in-country. Legal review is recommended before the first Saudi contract.

## Commercial model and packaging

Proposed: subscription pricing with free report-only users, three plans, and a separate license for dedicated deployments. Final prices need business input.

| Plan                                            | For                                       | Includes                                                                                                                                                    |
|-------------------------------------------------|-------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Starter (SaaS)                                  | Clinics and small hospitals               | Incidents & hazards, actions, policies with standard workflows, standard dashboards, English/Arabic                                                         |
| Professional (SaaS)                             | Mid-size hospitals and groups             | Starter + RCA, risk management, training & awareness, acknowledgement campaigns, report builder, SSO, AI features                                           |
| Enterprise (SaaS dedicated DB or single-tenant) | Health clusters, government, large groups | Professional + dedicated hosting, in-country deployment, custom workflows, API and webhooks, HIS/EMR and Teams integrations, BI export, premium support SLA |

**Pricing options for business to choose from:**

- **Per licensed (non-reporter) user per month**: simple; reporters always free.

- **Per bed per year**: common for hospitals, predictable for both sides.

- **Per facility per year plus modules**: suits health clusters with many sites.

**Extra revenue:** implementation and configuration, data migration from legacy systems, integrations, training and accreditation-readiness services, AI usage above plan quota.

## Phased delivery roadmap

Build in four phases; each ends with a working, demonstrable product. Durations are to be confirmed after engineering estimation.

| Phase              | Goal                                  | Scope                                                                                                                                                                                                                                                                                                                  | Exit criteria                                                 |
|--------------------|---------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|---------------------------------------------------------------|
| 0\. Foundation     | A secure base all modules reuse       | Multi-tenancy, SSO and automatic accounts, roles and permissions, org structure, audit trail, notifications, English/Arabic, approval-workflow engine, demo hospital data                                                                                                                                              | Demo tenant running; security and tenant-isolation tests pass |
| 1\. MVP (sellable) | First pilot hospital live             | Incidents, near misses and hazards; QR and anonymous reporting; triage and department response; actions (CAPA); policies with approval cycle and e-signature; core dashboards and reports; safety alerts; embedded "Report" button with SSO; AI drafting and report structuring                                        | One pilot hospital using it daily                             |
| 2\. Professional   | Full quality-department toolkit       | Investigations and RCA; risk management; acknowledgement campaigns and quizzes; training & awareness with signed attendance and certificates; report builder and scheduled reports; AI triage, "Ask the policies", gap analysis; grouped investigations; safety huddles; open disclosure; WhatsApp and voice reporting | Sold to 3+ paying clients                                     |
| 3\. Enterprise     | Large hospitals, clusters, government | Visual workflow designer, automatic user provisioning (SCIM), public API, EMR launch, Teams app, maintenance-ticket integration, in-country dedicated deployments, cluster dashboards and benchmarking, audits, complaints, accreditation tracker, KPIs, M&M reviews, Power BI                                         | First enterprise / cluster contract                           |
| 4\. Extensions     | Broaden the platform                  | Automatic event detection from HIS data, native mobile apps, credentialing, standard e-learning content and LMS synchronization, infection-control surveillance                                                                                                                                                        | Driven by client demand                                       |

## Success measures

| Measure                                           | Target (proposed)                                                   |
|---------------------------------------------------|---------------------------------------------------------------------|
| Time for staff to submit a report                 | Under 2 minutes                                                     |
| Change in incident reporting volume at pilot site | Increase within 6 months (a sign of better reporting culture)       |
| Share of reports triaged within deadline          | 95% or more                                                         |
| Overdue corrective actions                        | Under 10% of open actions                                           |
| Policies past their review date                   | Under 5%                                                            |
| Policy acknowledgement completion                 | 90% or more of targeted staff                                       |
| Pilot client satisfaction                         | Willing to act as a reference                                       |
| Commercial                                        | Paying clients and annual recurring revenue targets set by business |

## Risks and mitigations

| Risk                                                      | Impact                                   | Mitigation                                                                                                              |
|-----------------------------------------------------------|------------------------------------------|-------------------------------------------------------------------------------------------------------------------------|
| Strong incumbents (RLDatix, MEG) already in GCC hospitals | Longer sales cycles, price pressure      | Target hospitals still on paper or in-house OVR systems; win on Arabic UX, local hosting, price and speed of deployment |
| Data-residency and PDPL rules (KSA)                       | Deals blocked without in-country hosting | In-Kingdom hosting option at launch; in-country or self-hosted AI option; legal review                                  |
| Healthcare security reviews                               | Delayed procurement                      | Build to ISO 27001 / SOC 2 controls from day one; penetration test before first go-live                                 |
| AI errors or patient data exposure                        | Clinical and reputational harm           | AI only suggests; patient identifiers removed; per-client switch-off; full logging                                      |
| Scope creep from first clients                            | Delays to MVP                            | Strict phase gates; client-specific needs handled through configuration, not custom code                                |
| Low staff adoption                                        | Low reporting, weak value                | SSO and embedded "Report" button, mobile and QR reporting, anonymous option, "good catch" recognition, training         |
| Integration complexity with each HIS                      | Slower enterprise rollouts               | Industry-standard integration protocols and a reusable integration toolkit                                              |

## Out of scope and assumptions

**Out of scope for MVP:** clinical decision support, claims and legal case management, credentialing, native mobile apps (a mobile web app is included), and automatic event detection from HIS data.

**Assumptions:**

- A pilot hospital is available to co-design and test the MVP.

- Clients provide their own licensed accreditation standard texts; Trustline ships the structure only.

- Hosting will use a cloud provider with in-country data centers in each launch market (to be selected), or client infrastructure for on-premises deployments.

## Decisions required from business

- [ ] **Product name:** confirm "Trustline" (alternatives: Vigilo, Qorvant, Clarivo, Assuro), subject to trademark and domain checks.

- [ ] **Pilot client:** which hospital, and whether JCI or CBAHI drives the default setup.

- [ ] **Pricing model:** per user, per bed, or per facility (see Commercial model).

- [ ] **Launch regions:** KSA only, or KSA and UAE at launch.

- [ ] **AI policy:** default AI provider, and whether to offer an in-country or self-hosted AI option from day one.

- [ ] **Additional ideas:** confirm which items from "Additional ideas and differentiators" to keep, and their phase.

- [ ] **Investment:** team size and budget for Phases 0–1, after engineering estimation.

## Approval sign-off

| Role | Name | Decision (Approve / Approve with changes / Reject) | Comments | Date |
|------|------|----------------------------------------------------|----------|------|
|      |      |                                                    |          |      |
|      |      |                                                    |          |      |
|      |      |                                                    |          |      |
|      |      |                                                    |          |      |
|      |      |                                                    |          |      |

## Sources

Market figures and competitor details were checked on 19 Nov 2026 from the pages linked in each section: Fortune Business Insights, Persistence Market Research, Coherent MI, RLDatix, MEG, Origami Risk, IHI, the King Khalid University Hospital study (Abu Alrub et al., 2022), the Saudi Patient Safety Center presentation, Gowling WLG and MomentumX.
