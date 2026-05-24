# AegisDial — App Store Connect Submission Pack

Everything you paste into App Store Connect to ship 1.0. Keep this file
in sync with the actual fields in ASC — when you change copy in one,
update the other.

---

## 1. App Information

| Field | Value |
|---|---|
| Name | AegisDial |
| Subtitle (30 char) | Stop the scam. Recover faster. |
| Category Primary | Utilities |
| Category Secondary | Finance |
| Bundle ID | com.aegisdial.app |
| Age Rating | 4+ |

---

## 2. Promotional Text (170 char, editable post-launch)

AegisDial blocks scam calls before they connect, coaches you when one
slips through, and walks you through recovery if it already happened.

---

## 3. Description (4000 char max)

```
Scams cost Americans over $10 billion last year. Older adults lose more
than $3 billion of that — usually after one phone call.

AegisDial is the first app built for the moment a scam call is
happening. It's not a spam filter or a contact list — it's a real-time
coach that recognises the patterns scammers use ("transfer now",
"don't tell anyone", "your social security number is suspended") and
helps you intervene before money moves.

PREVENT
• Live Shield coaching during suspicious calls — see the playbook the
  scammer is running and the exact counter-script to use
• Bank fraud-line one-tap dialer — call your bank's real number the
  moment something feels off
• Family alert escalation — your designated guardian gets pinged if
  you're in the middle of a high-risk call
• Breach monitoring on emails and phone numbers tied to your identity

RECOVER
• Recovery Companion chatbot — guided steps for the first 24 hours
  after you've sent money to a scammer
• Bank routing finder — instant access to the right fraud-department
  phone number for 200+ US banks
• Evidence packet builder — collects everything investigators need
  in one place
• Live recovery agent (Recovery Concierge tier) — a dedicated
  specialist who runs the whole recovery process for you

PRICING
• Pro Monthly — $49.99/mo (3 lines on a family plan)
• Pro Annual — $399/yr (save $200 vs monthly)
• Recovery Session — $149 one-time, includes 14 days of Pro
• Recovery Concierge Monthly — $99/mo (dedicated agent + priority)
• Recovery Concierge Annual — $899/yr

PRIVACY
Live Shield analyses call audio in chunks; on free/trial tiers the
analysis is regex-only and runs entirely on-device. Pro tier uses
encrypted chunk transmission to our coaching engine — audio is never
stored. Sign in with Apple is supported. Your contacts, photos, and
microphone are only accessed when a specific feature needs them, and
the in-app prompts explain exactly what for.

We do not sell your data. We do not run ads. AegisDial is funded
entirely by subscriptions.

Built by 47 Industries. Questions? support@aegisdial.com
```

---

## 4. Keywords (100 char total, comma-separated, no spaces)

```
scam,fraud,call,protect,senior,phishing,robocall,security,family,recovery
```

---

## 5. Support / Marketing URLs

| Field | URL |
|---|---|
| Support URL | https://www.aegisdial.com/support (or https://api.aegisdial.com/support if web is still 502) |
| Marketing URL | https://www.aegisdial.com |
| Privacy Policy | https://www.aegisdial.com/privacy (fallback: https://api.aegisdial.com/privacy) |

---

## 6. Privacy Nutrition Labels (App Store Connect → App Privacy)

### Data Used to Track You
None.

### Data Linked to You
| Data Type | Purpose |
|---|---|
| Email Address | App Functionality |
| Phone Number | App Functionality |
| User ID | App Functionality, Analytics |
| Audio Data (Live Shield Pro only) | App Functionality |
| Other User Content (recovery evidence) | App Functionality |

### Data Not Linked to You
| Data Type | Purpose |
|---|---|
| Crash Data | Analytics |
| Performance Data | Analytics |
| Product Interaction | Analytics |

---

## 7. App Review Notes (paste into ASC → Submit → Notes)

```
DEMO CREDENTIALS

Sign in with Apple is the primary path. For reviewers without a usable
Apple ID on the review device, create an email account on the welcome
screen with any valid email + 8+ character password + birth year ≥ 13
years before submission date.

If you'd like to evaluate Pro-tier surfaces without billing:
  Email:    review@aegisdial.com
  Password: <set in ASC App Review Demo Account before submission>
That account is granted 30-day Pro via the /subscription/dev/grant
endpoint (development environment only — disabled in production).

KEY USER FLOWS TO REVIEW

1. Welcome → "See it work" → Live Shield demo
   Plays a scripted sample call with on-screen counter-scripts.
   Clearly labeled DEMO with a sample-call disclaimer banner.
   Real-time protection activates only when the user opens Live
   Shield mid-call themselves (microphone use is foreground-only).

2. Home → tap Live Shield card → same scripted demo experience

3. Settings → Help Center FAQ explains the actual on-device + Pro
   coaching engine boundaries. Privacy / Terms / Support URLs open
   the corresponding web pages.

4. Recovery Chatbot → free tier uses local-only pattern matching
   (subtitle "Fraud-recovery guide"); Pro tier shows "AI-powered
   fraud recovery" and routes through our backend coach. The bank
   fraud-line one-tap dialer in the AppBar opens tel: URLs for
   200+ US banks. Selecting one immediately calls the real bank's
   fraud line.

5. Breach Monitor → identifier scans go to our backend, which
   integrates with Enzoic. If Enzoic credentials are not provisioned
   at review time, the screen will display "Monitoring pending"
   rather than fake breach results.

6. Family screen → adding a contact stores it locally + on backend.
   "Text invite" opens iOS SMS composer with a prefilled invite
   message. "I've spoken with them" marks the contact verified.

PERMISSIONS

| Permission | When prompted | Why |
|---|---|---|
| Microphone | Open Live Shield or record family safe-word | Foreground audio only; no background listening |
| Speech Recognition | Family safe-word setup | One-time on-device transcription of safe word |
| Contacts | User chooses "Pick from contacts" in Family flow | Resolve a name + number for emergency alerts |
| Camera / Photo Library | Recovery evidence attachment | Capture screenshots of scam SMS, fake letters |
| Face ID | Unlock recovery evidence + family controls | Sensitive data gate |
| Push Notifications | After first sign-in | Family alerts + recovery status updates |

The app does NOT and CANNOT intercept phone-call audio on iOS — there
is no CallKit Extension. Live Shield is a user-initiated foreground
session.

CONTACT
Engineering: dean@aegisdial.com
Support:     support@aegisdial.com
```

---

## 8. Screenshot Specs (6.7", 6.5", 5.5" — required by ASC)

Render in Figma / Sketch / iOS Simulator at the exact pixel dimensions
ASC requires. Same six frames, three resolutions.

### Frame 1 — "AegisDial coaches you off a scam in real time"
- Screen: Live Shield demo mid-call (`live_shield_active.dart`)
- Show: scam transcript building up, fraud score gauge at 78, counter-
  script card visible
- Top: white headline, "AegisDial coaches you off a scam in real time"
- Bottom: turquoise sub-line "Live Shield · Pro tier"

### Frame 2 — "Bank fraud-line, one tap away"
- Screen: Recovery chatbot with bank-line jumper sheet open
- Show: list of bank names with chevrons; AppBar phone icon highlighted
- Top: "When seconds count, dial the right fraud line first"
- Bottom: "200+ US banks · one tap"

### Frame 3 — "Recovery companion walks you through the first hour"
- Screen: Recovery chatbot mid-conversation
- Show: AI message recommending FTC + IC3 + bank order
- Top: "After the call, AegisDial knows what to do next"

### Frame 4 — "Watch your identity across the breach web"
- Screen: Breach monitor with 2 identifiers + 1 exposure card
- Show: phone + email rows scanned, one breach exposure flagged
- Top: "If your phone or email surfaces in a breach, you'll know first"

### Frame 5 — "Family safety in one place"
- Screen: Family screen with 2 members + guardian set
- Top: "Set a guardian. They get a heads-up if AegisDial sees danger."

### Frame 6 — "Plans for prevention, plans for recovery"
- Screen: Paywall (`paywall_screen.dart`)
- Show: Pro Annual highlighted with BEST VALUE badge
- Top: "Pick a plan. Cancel any time."

---

## 9. Build Submission Checklist

Once all the above is filled in:

- [ ] Bundle ID matches Xcode (`com.aegisdial.app`)
- [ ] Build uploaded via Codemagic to TestFlight → Internal Testing
- [ ] Internal testers smoke-tested every flow listed in §7
- [ ] `REVENUECAT_IOS_API_KEY` set in Codemagic env group `codemagic`
- [ ] `REVENUECAT_WEBHOOK_SECRET` set in Railway env, RevenueCat dashboard
      points at `https://api.aegisdial.com/subscription/revenuecat/webhook`
- [ ] `/privacy` and `/terms` URLs return real HTML (currently fall back
      via api.aegisdial.com — verify www.aegisdial.com fix or update the
      URLs in this file before submitting)
- [ ] Apple Sign In + email login both succeed against production backend
- [ ] Privacy nutrition labels filled in ASC matching §6
- [ ] App Review notes pasted into ASC matching §7
- [ ] Screenshots uploaded for 6.7" / 6.5" / 5.5" (all 6 frames)
- [ ] App icon 1024x1024 is the current AegisDial shield (already in
      `ios/Runner/Assets.xcassets/AppIcon.appiconset/`)
