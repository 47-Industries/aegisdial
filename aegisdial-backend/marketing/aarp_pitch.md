# AegisDial x AARP Fraud Watch Network
### Partnership Pilot Proposal

Prepared for the AARP Fraud Watch Network leadership team.
Prepared by Kyle Rivers, Founder, AegisDial.

---

## 1. The ask

Let us be the overflow channel when the Fraud Watch helpline is at capacity.

We handle the immediate playbook. You keep the relationship with the member. 90-day pilot, 200 members, free.

---

## 2. Why AARP members need this

Older Americans remain the demographic most targeted by phone-based fraud, and the gap the Fraud Watch Network fills is already among the most valuable services AARP offers. The public record supports the urgency:

- The FTC's Consumer Sentinel Network consistently reports that adults aged 60+ lose more in aggregate to scams than any other age cohort, with phone calls being the most frequently reported contact method for the highest-loss categories.
- The FBI's Internet Crime Complaint Center (IC3) Elder Fraud Report places annual losses among victims 60+ in the multi-billion-dollar range, with tech-support, government-impersonation, and romance scams leading the severity tables.
- Public reporting on the Fraud Watch helpline (1-877-908-3360) has noted call volume spikes that exceed staff capacity, particularly during tax season, Medicare open enrollment, and after major breach events.

The operational problem is narrower than the fraud problem: the hour immediately after a scam is where recovery outcomes are decided. That is the window in which funds can still be clawed back, credentials rotated, and reports filed while memory is fresh. It is also the hour when a member in distress most needs a human-paced, step-by-step guide, and it is the hour when the helpline is most likely to be saturated.

This is where an always-on overflow tool has the most member impact and the least overlap with what AARP staff already do well.

---

## 3. What AegisDial actually does

**Live Shield** is the prevention side. It is an on-device iOS product that listens during suspicious inbound or outbound calls and warns the user mid-conversation when it detects scam patterns, phrasing, or social-engineering flow. All transcription and pattern matching run locally on the phone. Transcripts are not uploaded, not stored on our servers, and not used for training. To our knowledge, no existing consumer product (Truecaller, Hiya, carrier-level shields) offers mid-call intervention; they stop at pre-call caller-ID warnings. That is a meaningful gap for older users, who are most often victimized by numbers that have not yet been flagged.

**Recovery Concierge** is the post-scam side. It is a trauma-informed AI guide designed to walk a victim through the first 15 minutes after a scam. It covers 52 distinct scam categories, with playbooks written by fraud-investigation professionals. It pre-fills the FTC Consumer Sentinel and FBI IC3 report forms from the member's description, gives the member the specific phone numbers to call at their bank and carrier, and hands off to a human where appropriate. It is the piece that most directly reduces load on the Fraud Watch helpline during peak hours.

---

## 4. Why this fits AARP's mission, not just ours

The goal here is to extend what the Fraud Watch Network already does, not to replicate or replace it.

- **Volume relief.** When the helpline is full, the member currently gets a callback queue. With AegisDial, the member gets an immediate, structured first 15 minutes, then re-enters the AARP relationship when a human is free. Nothing about that displaces AARP staff; it buffers them.
- **A tool the Scam Alert newsletter can recommend.** The editorial team already publishes practical guidance. A product that members can install and use immediately fits that format.
- **Aggregate, opt-in trend data.** With explicit member consent, we can share anonymized, aggregate scam-pattern data with AARP's advocacy and research teams: what scripts are trending, which states are being hit, which impersonation targets are rising. Individual member data is never shared in any form.

The member stays an AARP member. The relationship, the brand, and the trust remain yours.

---

## 5. The 90-day pilot - structure

The pilot is designed to generate a real outcome signal with zero financial or reputational exposure for AARP.

- **200 AARP members receive free Pro access for 90 days.** Grants are issued through an admin endpoint on our side, not through the App Store, so there is no payment friction, no card on file, and no accidental charge risk.
- **Monthly outcome report** to the AARP partnership team: scams prevented pre-loss (Live Shield interventions that the member confirmed), Recovery sessions walked, dollars protected where reportable, and member NPS from an in-app survey.
- **Weekly 30-minute office hours** with AARP staff for feedback, bug triage, and edge cases encountered on the helpline.
- **Zero cost to AARP. Zero cost to the 200 members.** We fund the pilot.
- **No revenue share, no upsell into AARP.** Members who choose to continue after 90 days pay us directly on the App Store. AARP does not collect, does not endorse the paid tier, and is not positioned as a seller.

---

## 6. Privacy and compliance posture

We know this is where a partnership like this most often dies, so we want to be direct about where we are.

- **Encryption.** Member PII is encrypted at rest using AES-256-GCM envelope encryption. Keys are managed in a separate key-management service. In transit, TLS 1.2+.
- **Retention.** Data is retained on a tiered schedule, 30 to 730 days depending on data type. Members can export everything or delete everything in two taps, inside the app.
- **No data sold. No ad networks. No third-party analytics SDKs that exfiltrate user content.**
- **Age gate at 13+.** Live Shield is designed for adult use; AARP's membership demographic is outside the sensitive-minor range entirely.
- **SOC 2 Type II is in progress, not yet certified.** We want to flag this honestly. We are working toward a Type I report this year. If AARP requires certification before pilot, we can discuss scope and timeline; if AARP can accept in-progress status with a written control summary, we can move now.
- **BAA / DPA.** We can execute a Data Processing Agreement and, if scoped appropriately, a Business Associate Agreement. Standard terms, reviewable by AARP counsel before signature.

---

## 7. What happens after the pilot

Three outcomes, all pre-defined so nobody is surprised.

- **If outcomes are good:** we would welcome a conversation about AegisDial being offered to the broader AARP membership at a member-benefit discount, either as a standalone recommendation or under a co-brand arrangement AARP is comfortable with. No exclusivity. No board seat. No equity. AARP can end the relationship at any time with no financial penalty.
- **If outcomes are neutral:** we shake hands, we each keep our own data, and there are no residual obligations. No press release claiming a partnership that did not convert.
- **If outcomes are bad:** we will tell you why before you have to tell us to go. If the member feedback is negative or the tool causes confusion on the helpline, we would rather pull the pilot early and learn than let it damage the Fraud Watch brand.

---

## 8. Next steps

We are asking for one 30-minute introductory call.

**Tentative agenda:**
- 10 min - AARP context: current helpline load, pain points, what a good partner looks like to your team
- 15 min - Live Shield and Recovery Concierge product demo on a real iPhone
- 5 min - pilot structure questions

If a written security questionnaire is the gating step before the call, we are happy to complete it first.

---

**Kyle Rivers**
Founder, AegisDial
Email: kyle@aegisdial.com *(placeholder - to be confirmed on outreach)*
Phone: *(placeholder - provided on request)*

Thank you for your time and for the work the Fraud Watch Network does. We would be glad to be useful to it.
