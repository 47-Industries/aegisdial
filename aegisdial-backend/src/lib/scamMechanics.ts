// Scam mechanics catalog — the "how the scam actually runs, play by
// play" companion to scamTypeDescriptions.ts.
//
// scamTypeDescriptions.ts answers "what kind of scam is this?"
// scamMechanics.ts answers "how does this scam actually work, moment
// by moment, so I can explain it to the victim and help them recognize
// the pattern."
//
// This file is fed into the Recovery Companion AI's system prompt so
// the model can (a) educate victims on what just happened to them and
// (b) spot the pattern mid-call if the user is still on the phone.
//
// Sources (as of 2026-04-18):
//  - FTC Consumer Sentinel Network Data Book 2024
//  - FBI IC3 2024 Annual Report + Operation Level-Up bulletins
//  - AARP Fraud Watch Network 2025-2026 advisories
//  - BBB Scam Tracker 2024 Risk Report
//  - USPIS / FCC / FinCEN joint fraud notices
//  - HHS-OIG, VA OIG, FMCSA, CISA public advisories
//
// Writing rules:
//  - playbook is a timeline: opening → pressure → extraction.
//  - whyItWorks names the psychological lever (urgency, authority,
//    isolation, sunk cost, reciprocity, fear, love, etc).
//  - redFlags are concrete observable things, not platitudes.
//  - stopItNow assumes the user still has time to prevent loss and
//    gives them one or two specific actions.
//  - No hallucinated phone numbers or URLs. If a source is needed, refer
//    to "the number on the back of your card" or "the agency's
//    official website."

export interface ScamMechanics {
  /** 2-3 sentence playbook: opening → pressure → extraction. */
  playbook: string;
  /** 1-2 sentence explanation of why this works on smart, careful people. */
  whyItWorks: string;
  /** 3-5 concrete red flags the victim could have noticed (or can notice next time). */
  redFlags: string[];
  /** If the victim might still be mid-call or pre-loss, 1-2 sentences on what to do RIGHT NOW. */
  stopItNow: string;
}

export const SCAM_MECHANICS: Record<string, ScamMechanics> = {
  // ----- Impersonation ------------------------------------------------
  bank_impersonation: {
    playbook:
      'First they call with a spoofed caller ID that shows your bank\'s real name and warn of "unauthorized charges" or a "wire attempt from another state." Then they walk you through a fake verification and tell you a fraudster has inside access, so the only safe move is to transfer your balance to a "secure holding account" in your name. Finally they push you to Zelle, wire, or withdraw cash — sometimes to a Bitcoin ATM — while staying on the line so you can\'t call anyone to double-check.',
    whyItWorks:
      'Authority plus urgency: the caller names transactions that feel plausible, uses bank jargon, and turns you into their teammate fighting a fake threat instead of their target.',
    redFlags: [
      'Asked you to move money to a "safe" or "holding" account — real banks never do this.',
      'Told you not to tell the teller or branch staff the real reason for the withdrawal.',
      'Stayed on the line while you drove to the bank or ATM.',
      'Read back real account details they already had (from a breach) to sound legitimate.',
      'Pushed wire, Zelle, cash, or crypto instead of the bank\'s normal dispute process.',
    ],
    stopItNow:
      'Hang up right now and call the number printed on the back of your debit or credit card — do not call any number the caller gave you. If money hasn\'t moved yet, do not move it; a real fraud team can stop a pending transaction from the bank side.',
  },

  bank_employee_impersonation: {
    playbook:
      'First they claim to be from your own bank\'s fraud department and "verify" your identity by reciting partial account numbers, recent transactions, or your address (usually bought from a breach). Then they say an insider at the bank is stealing from accounts and ask you to help catch them by transferring funds or handing cash to a "federal courier." Finally they extract the money — wire, cashier\'s check, or cash pickup — under the cover of a fake investigation.',
    whyItWorks:
      'The recited real details flip you from skeptic to believer in seconds, and the "help us catch the criminal" framing makes you feel like a partner, not a mark.',
    redFlags: [
      'Asked you to keep the "investigation" secret from family or branch staff.',
      'Told you a courier or agent would come to your house to pick up cash.',
      'Gave you a case number and a supervisor to "confirm" — both fake.',
      'Used your real last four of the account as proof, even though that info is in dozens of breaches.',
      'Refused to let you hang up and call the bank back directly.',
    ],
    stopItNow:
      'End the call, wait two minutes, and call your bank using the number on your card or app — not a callback number from the caller. No bank ever uses couriers to collect cash from customers.',
  },

  irs_impersonation: {
    playbook:
      'First they call saying you owe back taxes and a warrant has been issued or is about to be — sometimes with a badge number and fake case ID. Then they threaten arrest, deportation, or a suspended driver\'s license within the hour unless you pay immediately. Finally they direct you to pay in gift cards, wire, cryptocurrency, or a Bitcoin ATM "to settle before the warrant executes."',
    whyItWorks:
      'Authority plus fear of jail plus a countdown: most people have never been contacted by the IRS and don\'t know what\'s normal, so the ticking clock overrides their judgment.',
    redFlags: [
      'Demanded payment by gift card, wire, crypto, or Bitcoin ATM — the real IRS never asks for these.',
      'Threatened immediate arrest, deportation, or license suspension.',
      'Refused to let you hang up and call the IRS back.',
      'Did not send any prior letter — the IRS contacts taxpayers by mail first.',
      'Asked for your SSN to "verify" rather than your tax transcript PIN.',
    ],
    stopItNow:
      'Hang up. The IRS will never demand payment in gift cards, never threaten immediate arrest, and never refuse to let you verify by mail. If you want to check for any real balance owed, log in at the IRS\'s official website or call the published IRS line.',
  },

  irs_refund_bait: {
    playbook:
      'First they call or email saying you have an unclaimed IRS refund, often a very specific dollar amount, sometimes citing a "stimulus reissue" or "ERC credit." Then they ask for your SSN, full bank routing and account number, or a small "processing fee" to release it. Finally they either drain the account with the info they collected or use your identity to file a fraudulent return next tax season.',
    whyItWorks:
      'Loss aversion flipped: instead of fearing loss, you\'re chasing a gain you almost certainly forgot you had, which lowers the usual skepticism.',
    redFlags: [
      'Unsolicited call, text, or email about a refund you didn\'t know about.',
      'Asked for your full bank account and routing number over the phone.',
      'Mentioned a "processing fee" or "release fee" for your own refund.',
      'Pressured you to click a link to claim the refund right now.',
      'Wanted your SSN to "verify" — real refund deposits don\'t need re-verification.',
    ],
    stopItNow:
      'Don\'t share any numbers. Check any real refund status only through the IRS\'s official "Where\'s My Refund" tool on their website.',
  },

  ssa_impersonation: {
    playbook:
      'First they call claiming your Social Security number has been "suspended" or linked to crimes — often drug trafficking or money found in a rental car in Texas. Then they transfer you to a fake "officer" who says you must verify your SSN and move funds into a government-controlled account to protect them while the case is investigated. Finally they walk you to a bank or Bitcoin ATM and extract the cash under the "protection" frame.',
    whyItWorks:
      'Most Americans don\'t know the SSA cannot suspend a Social Security number — that phrase alone is the tell, but it sounds official enough to get your attention.',
    redFlags: [
      'Said your SSN was "suspended" — this is not a real thing; SSNs are not suspended.',
      'Claimed your SSN was linked to crimes or a rental car in Texas (a scripted detail).',
      'Told you to move money into a "protected" government account.',
      'Used a robocall opener with a press-one-to-speak-to-an-officer menu.',
      'Caller ID spoofed a government-sounding number.',
    ],
    stopItNow:
      'Hang up. If you want to confirm anything about your Social Security record, call SSA directly at the number on the Social Security Administration\'s official website — never a callback number from the caller.',
  },

  law_enforcement_impersonation: {
    playbook:
      'First they call from a spoofed local sheriff or police number saying you missed jury duty, have a failure-to-appear warrant, or didn\'t respond to a subpoena. Then they give you a choice: drive to the courthouse and be booked, or "post bond" over the phone right now to clear the warrant. Finally they direct the "bond" payment to gift cards, a payment app, a Bitcoin ATM, or cash handed to a courier.',
    whyItWorks:
      'Fear of arrest, shame about a public record, and the natural instinct to comply with police combine to override the normally obvious fact that no police department takes bond by gift card.',
    redFlags: [
      'Asked you to pay a bond or fine by gift card, wire, crypto, or payment app.',
      'Told you not to hang up or "the warrant activates."',
      'Refused to let you show up in person to resolve it.',
      'Used a deputy\'s real name from the department\'s website (publicly listed).',
      'Discouraged you from calling your lawyer or the courthouse directly.',
    ],
    stopItNow:
      'Hang up and call the non-emergency line of the sheriff or police department using the number on their official website. No US law enforcement agency takes bond or fine payments by gift card, crypto, or wire over the phone.',
  },

  fbi_dea_impersonation: {
    playbook:
      'First they call claiming your name, SSN, or bank account is connected to a federal investigation — usually drug money found at the border or an identity-theft ring. Then they "transfer" you to a fake agent who tells you to keep the investigation confidential and verify your assets by moving them to a Treasury "safe account" or buying gold. Finally they extract funds by wire, cashier\'s check, crypto, or a courier who comes to your home for cash or gold bars.',
    whyItWorks:
      'Federal agencies are intimidating and mysterious; "confidential federal investigation" is exactly the phrase that makes people afraid to call their spouse, lawyer, or local police to sanity-check.',
    redFlags: [
      'Told you not to discuss the "investigation" with anyone, including family.',
      'Asked you to buy gold bars or move assets to a "Treasury" account.',
      'Sent a courier to pick up cash, gold, or a cashier\'s check.',
      'Used a badge number and agent name you couldn\'t verify.',
      'Claimed to be calling from a 202 or border-state area code.',
    ],
    stopItNow:
      'Hang up. The FBI and DEA do not call people to negotiate. Call your local FBI field office using the number on the FBI\'s official website if you want to confirm — and tell a family member what happened before you move any money.',
  },

  uscis_ice_impersonation: {
    playbook:
      'First they call claiming your immigration file has a "problem" — a missing form, an expired status, or a removal order scheduled — and often speak in the target\'s native language. Then they threaten deportation, detention, or a block on your citizenship unless you pay a "filing correction fee" today. Finally they extract money by gift card, wire, or payment app, sometimes also harvesting A-numbers and document scans for identity theft.',
    whyItWorks:
      'Immigration status is existential, and many targets don\'t have family members who know the US system well enough to immediately push back.',
    redFlags: [
      'Demanded immediate payment by gift card, wire, or payment app to fix an immigration issue.',
      'Threatened deportation or detention over the phone.',
      'Asked for your A-number plus other personal info in the same call.',
      'Refused to let you call USCIS back at the official number.',
      'Used fear about English skills or lawyer cost to keep you on the line.',
    ],
    stopItNow:
      'Hang up. USCIS and ICE do not call for payments over the phone. Check your case status at the official USCIS website, or call the USCIS contact center directly. If you\'re worried, reach a trusted immigration attorney or accredited representative before paying anything.',
  },

  digital_arrest: {
    playbook:
      'First they call as police, customs, or a federal agency claiming your identity has been used in a serious crime and you are now under "digital house arrest" — you must stay on the phone and on camera at home until cleared. Then they keep you on a video or audio line for hours, sometimes days, forbidding you from telling anyone. Finally they demand you transfer all "suspect" funds to a government-verified account so they can be "audited and returned," and the money disappears.',
    whyItWorks:
      'Sustained isolation plus fear of arrest is a textbook coercion technique. Hours on the call with no breaks wears down the victim\'s ability to reason or seek help.',
    redFlags: [
      '"Digital arrest" or "digital custody" is not a real legal concept anywhere in the US.',
      'Told you to stay on video and not leave your home or speak to family.',
      'Showed you a fake warrant, badge, or arrest document over video.',
      'Demanded that all your bank balances be "audited" by transfer.',
      'Escalated to a senior "judge" or "officer" to increase pressure.',
    ],
    stopItNow:
      'Hang up and walk away from the phone. Tell a family member or neighbor immediately — breaking isolation is the single most important thing. Then call your local police non-emergency line using the number from their official website.',
  },

  medicare_impersonation: {
    playbook:
      'First they call saying Medicare is issuing new cards — plastic, chip-enabled, genetic-testing eligible, or similar — and they just need to "verify" your Medicare number. Then they walk you through confirming your MBI, date of birth, and sometimes bank or supplement plan details. Finally they use those details to bill Medicare for fraudulent services, sell the MBI, or enroll you in an unwanted plan.',
    whyItWorks:
      'Medicare is confusing for almost everyone, and the caller sounds like they are doing you a favor by helping you not miss out on a new benefit.',
    redFlags: [
      'Asked for your Medicare number, MBI, or SSN to "issue a new card."',
      'Offered a free DNA test, back brace, or diabetic supplies in exchange for your MBI.',
      'Claimed Medicare is issuing new chip cards (there is no such program).',
      'Pressured you to answer today or "lose the benefit."',
      'Called you without you ever contacting Medicare first.',
    ],
    stopItNow:
      'Do not share your Medicare number. Hang up and, if you have a specific question, call 1-800-MEDICARE using the number on your card or the official Medicare.gov site.',
  },

  medicare_advantage_switch: {
    playbook:
      'First a "licensed agent" calls during or near open enrollment and says your current plan will not cover something you need — a doctor, a drug, a hospital. Then they offer a Medicare Advantage plan with "better" dental, vision, or grocery benefits and push you to enroll over the phone today. Finally they harvest your MBI and signature by recorded voice consent, often switching you out of a plan that actually worked for your doctors.',
    whyItWorks:
      'Benefits plus fear of losing coverage plus a commissioned agent who is trained to sound like a neutral adviser.',
    redFlags: [
      'Cold-called you about Medicare Advantage — CMS rules restrict unsolicited plan sales calls.',
      'Promised flex cards, grocery money, or cash-back amounts that sounded too high.',
      'Asked for a voice "yes" to enroll without a written disclosure.',
      'Could not tell you if your specific doctors were in-network.',
      'Pushed you to decide before the call ended.',
    ],
    stopItNow:
      'Don\'t give a verbal "yes" to enrollment today. Call 1-800-MEDICARE or your State Health Insurance Assistance Program (SHIP) to compare plans with someone who isn\'t paid a commission.',
  },

  utility_shutoff: {
    playbook:
      'First they call claiming your power, gas, or water account is past due and a truck is dispatching to cut service within 30 to 60 minutes. Then they offer to stop the shutoff if you pay now on a prepaid card, gift card, or through a "secure utility portal" link they text you. Finally they collect the payment codes or card info, and service was never actually at risk.',
    whyItWorks:
      'Fear of losing heat, AC, or lights in front of family or employees pushes even careful people into a 15-minute emergency decision.',
    redFlags: [
      'Demanded payment by gift card or prepaid card — no US utility accepts these.',
      'Threatened disconnection within the hour with no prior written notice.',
      'Texted a payment link rather than using your utility\'s real app.',
      'Refused to let you hang up and call the utility back.',
      'Would not look up your account by service address, only by the caller\'s quoted number.',
    ],
    stopItNow:
      'Hang up and call your utility using the number on your last paper bill or their official website. Real utilities send written shutoff notices days or weeks in advance, not phone calls with countdowns.',
  },

  // ----- Tech / credential theft --------------------------------------
  tech_support: {
    playbook:
      'First a pop-up, call, or email warns that your computer is infected, your Apple ID is compromised, or your router has been "hacked from Russia." Then they walk you into installing remote-access software (AnyDesk, TeamViewer, UltraViewer) so they can "run a scan." Finally, while they have your screen, they open your banking, show you fake "hacker transfers" they\'ve staged, and convince you to move real money to a "safe" account or buy gift cards to "trap" the hacker.',
    whyItWorks:
      'You\'re not a tech expert, they are; once they\'re on your screen the authority gap is total and everything they show you looks real.',
    redFlags: [
      'A pop-up or call asked you to install remote-access software.',
      'Showed you "hacker activity" on your screen you\'d never seen before.',
      'Asked you to log into your bank while they watched.',
      'Directed you to gift cards or wire transfers to "trap" or "trace" the hacker.',
      'Would not let you hang up and restart the call from your bank\'s official number.',
    ],
    stopItNow:
      'Disconnect your computer from Wi-Fi right now. Uninstall any remote-access app they had you install. Then call your bank on the number from the back of your card to freeze accounts before any wires settle.',
  },

  fake_refund_scam: {
    playbook:
      'First you get an email or call about a renewal charge — Geek Squad, Norton, McAfee, Amazon Prime, PayPal — for a product you didn\'t buy, with a number to call for a refund. Then a "refund agent" has you install remote software and log into your bank to process the refund. Finally, they claim they "accidentally" refunded $5,000 instead of $500 and cry that they\'ll lose their job unless you wire, Zelle, or gift-card the extra back — but no refund was ever issued; they only moved money between your own accounts to make it look that way.',
    whyItWorks:
      'Reciprocity and pity: they "made a mistake" and you feel obligated to help make them whole, which is a completely different decision frame than "hand money to a stranger."',
    redFlags: [
      'Received a refund receipt for a subscription you never bought.',
      'The "agent" needed remote access to your computer to process a refund.',
      'A refund was supposedly "overpaid" and you need to send back the difference.',
      'Asked you to Zelle, wire, or buy gift cards to "return" the extra.',
      'Cried, begged, or said they\'d lose their job if you didn\'t help immediately.',
    ],
    stopItNow:
      'Turn off your computer\'s Wi-Fi. Do not send any money — the "overpayment" is money moved between your own accounts. Call your bank on the card\'s phone number and tell them you gave someone remote access.',
  },

  apple_icloud_locked: {
    playbook:
      'First you see a pop-up or get a call saying your Apple ID or iCloud has been locked for suspicious activity, often with Apple\'s real logo and a scary siren sound. Then a "senior Apple advisor" asks for your Apple ID password and, critically, the 6-digit 2FA code Apple just texted you "to confirm it\'s you." Finally, with your password and code, they sign into your Apple ID from their device, lock you out, and use it to push iMessage scams or extract photos and contacts.',
    whyItWorks:
      'The Apple branding is convincing and 2FA codes feel like proof of identity, so reading one out loud feels protective rather than catastrophic.',
    redFlags: [
      'A call or pop-up asked for your Apple ID password.',
      'Asked you to read back a 6-digit code Apple sent — Apple never asks for these.',
      'Pop-up told you to call a phone number.',
      'Threatened to "delete" your iCloud unless you acted right now.',
      'Used a 1-800 number that claimed to be Apple Support (Apple does not operate inbound 800-number cold support).',
    ],
    stopItNow:
      'Close the pop-up or hang up. Change your Apple ID password at appleid.apple.com using a device you\'ve been signed into, and revoke any unfamiliar sessions under Devices. If you gave out a code, change the password immediately — minutes matter.',
  },

  google_account_takeover: {
    playbook:
      'First you get a text, email, or call about "suspicious sign-in from another country" with a link to secure your account. Then the phishing page asks for your Google password and triggers a real Google prompt on your phone to approve or a real 2FA code to share. Finally, once they have access, they change recovery info, lock you out, and use Gmail to pivot into banks, brokerages, and crypto exchanges.',
    whyItWorks:
      'A legitimate-looking alert from Google plus the comfort of real-looking 2FA prompts makes approval feel like you\'re protecting yourself, not giving away the keys.',
    redFlags: [
      'A link to "secure your Google account" in an email or text you weren\'t expecting.',
      'Asked you to tap "Yes, it\'s me" on a Google prompt you didn\'t initiate.',
      'Asked you to read a 6-digit Google verification code.',
      'Login page URL wasn\'t accounts.google.com.',
      'Call claimed to be from Google Support (Google does not do cold support calls).',
    ],
    stopItNow:
      'Go directly to myaccount.google.com, check Security → Recent activity, and sign out of all sessions. Change your password and, if possible, switch to a passkey or hardware security key.',
  },

  sim_swap_port_out: {
    playbook:
      'First the attacker collects enough of your info from breaches and social engineering to impersonate you to your carrier. Then they call the carrier claiming a lost phone and request a SIM swap or a port-out to a new carrier. Finally, once your number is on their SIM, they intercept banking 2FA SMS codes and reset passwords at your bank, brokerage, and crypto exchange within minutes.',
    whyItWorks:
      'Carriers have historically trained reps to resolve customer frustration quickly, and account PINs are often weak or reused. The victim sees service drop and doesn\'t immediately realize why.',
    redFlags: [
      'Your phone suddenly shows "No service" or "SOS only" for no weather or outage reason.',
      'You got a text or email confirming a SIM change or number transfer you didn\'t request.',
      'You stopped receiving 2FA codes but your Wi-Fi still works.',
      'Your bank emailed about a login, transfer, or password change you didn\'t make.',
      'Family members say they got a weird text from "you" asking for money or codes.',
    ],
    stopItNow:
      'Call your carrier from another phone right now and tell them your number has been ported without consent — ask them to reverse it and put a port-out PIN on the account. Then log into your bank and brokerage from a trusted device, change passwords, and pull 2FA off SMS onto an authenticator app.',
  },

  banking_app_push_bombing: {
    playbook:
      'First the attacker has your banking password from a breach or phishing page. Then they trigger dozens or hundreds of MFA push approvals to your phone at 2 a.m., hoping that eventually you\'ll tap "Approve" to make the buzzing stop. Finally, the moment you approve, they log in and move funds by Zelle, wire, or ACH within the bank\'s same-session window.',
    whyItWorks:
      'Push fatigue is a known attack: after the twentieth prompt, your brain treats "approve" as a way to end an annoyance rather than a security decision.',
    redFlags: [
      'A flood of bank login approval prompts on your phone, often overnight.',
      'Emails confirming password change attempts you didn\'t make.',
      'A call pretending to be bank security while the prompts are happening, asking you to "approve" to stop them.',
      'Unexpected Zelle or ACH transactions right after you approved one.',
      'Your Face ID or fingerprint login to the app suddenly stops working.',
    ],
    stopItNow:
      'Do not tap approve on anything. Open the bank\'s app yourself, change your password, and call the bank\'s number on the back of your card. Any Zelle sent in the last few minutes should be flagged for reversal immediately.',
  },

  quishing_qr_phishing: {
    playbook:
      'First you see a QR code somewhere it looks legitimate — a parking meter sticker, a restaurant table tent, an emailed invoice, or a mailed "failed delivery" notice. Then scanning it takes you to a page that clones your bank, the USPS, or a parking authority and asks for a login plus card info. Finally the credentials are harvested and used for drain attempts within minutes, or the card is used for online test purchases.',
    whyItWorks:
      'QR codes feel modern and safe, and nobody reads the URL that pops up after scanning. The physical world context (a real parking meter, a real mailbox) lends credibility the page itself doesn\'t deserve.',
    redFlags: [
      'A QR code sticker placed over another QR code on a public meter or sign.',
      'A QR code in an unsolicited email or physical mail.',
      'The URL after scanning didn\'t match the agency or company\'s real domain.',
      'The page asked for full card info, SSN, or online banking login.',
      'The page loaded extremely fast and looked pixel-perfect — a tell for a prebuilt phish kit.',
    ],
    stopItNow:
      'Don\'t submit anything. If you already entered card info, call your card issuer on the back of the card and ask for a new card number. If you entered a bank login, change your password and pull 2FA off SMS.',
  },

  clickfix_malware: {
    playbook:
      'First you hit a webpage showing a fake "verify you are human," "fix your browser," or "document viewer needs an update" prompt. Then it instructs you to press Windows+R (or open Terminal on Mac) and paste a command it already copied to your clipboard — sometimes using a fake CAPTCHA puzzle to disguise the step. Finally, running that command installs info-stealer malware that scrapes browser-saved passwords, crypto wallets, and session cookies.',
    whyItWorks:
      'The instruction feels like a harmless troubleshooting step, and most people have no idea why pasting into Terminal or Run would be different from clicking a button.',
    redFlags: [
      'A website told you to paste a command into Terminal, PowerShell, or the Run box.',
      'Instructions referenced Windows+R, Win+X, or opening Terminal as part of a "verification."',
      'You never manually copied anything but the paste was prefilled.',
      'The "CAPTCHA" had unusual steps like "press these three keys."',
      'A browser warning popped up after you ran it.',
    ],
    stopItNow:
      'Disconnect from Wi-Fi. On the same device, do not log into anything else. Change your most important passwords (email, bank) from a different trusted device, then run a reputable malware scanner — and assume any crypto wallet seed saved in your browser is compromised.',
  },

  brokerage_401k_phishing: {
    playbook:
      'First they call or email pretending to be Fidelity, Vanguard, Schwab, Empower, or your employer\'s plan administrator about "unauthorized access" or a "required rebalance." Then they direct you to a login page that captures your credentials and 2FA code, or walk you through initiating a distribution "to verify identity." Finally they trigger an ACH withdrawal or full liquidation — often to a newly added external bank account — before you notice.',
    whyItWorks:
      'Retirement accounts are rarely logged into, so both normal activity and anomalies look unfamiliar. The target assumes the caller knows more than they do.',
    redFlags: [
      'Unsolicited call or email about your 401(k) or IRA.',
      'Login URL was close to but not exactly the firm\'s real domain.',
      'Asked you to add a new bank account to your brokerage on the call.',
      'Pressured you to authorize a distribution "to verify ownership."',
      'Claimed to be "plan administrator" but couldn\'t name your employer plan correctly.',
    ],
    stopItNow:
      'Log directly into your brokerage from a bookmark or their app — not a link — and check for newly added bank accounts, recent distributions, or changed email addresses. Call the brokerage\'s number on their official site to lock the account.',
  },

  // ----- Emotional ----------------------------------------------------
  grandchild_emergency: {
    playbook:
      'First they call, often crying, saying "Grandma? It\'s me — I\'m in trouble," and wait for you to supply the grandchild\'s name. Then a second voice jumps in as a lawyer, bail bondsman, or officer explaining your grandchild was arrested in an accident (often involving drugs or injury to a pregnant woman) and there\'s a gag order so nobody else in the family can be called. Finally they send a courier to your house to pick up cash, gift cards, or a cashier\'s check for "bail."',
    whyItWorks:
      'Love, panic, and shame for the grandchild override every other instinct. The "gag order" is a manufactured secrecy rule that keeps you from the one person who could stop the scam — another family member.',
    redFlags: [
      'Caller wouldn\'t give a name until you guessed it.',
      'Told you not to tell their parents or other family.',
      'Sent a courier to pick up cash or gift cards.',
      'Claimed a "gag order" or "court-sealed case."',
      'Story involved a pregnant woman, a DUI, or an out-of-state accident — all common scripts.',
    ],
    stopItNow:
      'Hang up and call your grandchild directly, or call their parents. Set a family safe word today — one word only you would know. Couriers do not collect bail; real bail is paid to a court or licensed bondsman, never to a stranger at your door.',
  },

  ai_voice_clone_family: {
    playbook:
      'First the attacker scrapes 10–30 seconds of your family member\'s voice from TikTok, Instagram, a podcast, or a voicemail, and clones it with a consumer AI tool. Then they call you with the cloned voice in tears — "I\'ve been in an accident" or "I\'ve been kidnapped" — and pass the phone to a "lawyer" or "officer." Finally they extract cash, wire, or crypto under the same courier or gift-card routine as the classic grandchild scam.',
    whyItWorks:
      'Your brain has decades of training that says "this voice = this person." A 15-second clone is usually enough to bypass that recognition under stress.',
    redFlags: [
      'Voice sounded right but the call came from an unknown or "unavailable" number.',
      'Urgent, no time to verify, "don\'t hang up."',
      'The person couldn\'t answer a simple family-only question.',
      'Background noise was thin or unnatural — AI clones often lack realistic ambience.',
      'The "lawyer" or "officer" took over quickly and controlled the conversation.',
    ],
    stopItNow:
      'Hang up and call the family member on the number you already have for them. Agree on a family safe word today — a voice clone cannot know it. Tell other relatives about the attempt so they\'re not targeted next.',
  },

  virtual_kidnapping: {
    playbook:
      'First they call screaming that your child or spouse has been kidnapped — sometimes with a crying voice in the background (real, cloned, or a stock audio clip). Then they demand you stay on the line, not contact anyone, and drive to a Western Union, MoneyGram, or Bitcoin ATM for ransom. Finally, while you\'re isolated on the call, they extract as much cash as you can send before you discover your loved one is actually safe.',
    whyItWorks:
      'The adrenaline of imagined child harm is the strongest psychological lever a scammer can pull, and being told not to hang up is an isolation tactic lifted from real kidnapping negotiations.',
    redFlags: [
      'Caller said "don\'t hang up or we\'ll hurt them."',
      'Would not let you speak to your loved one directly.',
      'Demanded wire, gift card, or Bitcoin ATM — not a normal ransom medium.',
      'Call came while the supposed victim was at school, work, or somewhere you could verify.',
      'Crying in the background sounded looped or the same phrase repeated.',
    ],
    stopItNow:
      'Have someone else in the room or on another phone call the supposed victim directly right now. Do not send any money until you confirm. Real kidnappings are rare in the US; virtual kidnapping scams are common.',
  },

  sextortion: {
    playbook:
      'First the target (often a teen boy or an adult on a dating app) is pulled into a flirty chat that moves quickly to exchanging explicit images. Then the scammer reveals they have the images (and often a contact list scraped from social media) and demands payment within hours or they\'ll send the images to the target\'s family, coworkers, or followers. Finally they collect by Cash App, PayPal, gift cards, or crypto — and frequently come back for more after the first payment.',
    whyItWorks:
      'Shame and panic collapse the normal 24-hour pause. The target tries to handle it alone, which is exactly what the extortionist needs.',
    redFlags: [
      'New online contact who moved very fast to sexual content.',
      'Threat to share images with a specific list of your real contacts.',
      'Demanded payment in crypto, Cash App, or gift cards, "or in one hour I post."',
      'Came back for a second payment after you paid the first.',
      'Account had very few posts, stolen-looking photos, or was created recently.',
    ],
    stopItNow:
      'Do not pay — paying almost always leads to more demands. Stop responding, screenshot the messages, and report the account on the platform. If the target is a minor, contact NCMEC\'s CyberTipline immediately, and tell a trusted adult or therapist — shame is the weapon, and saying it out loud defuses it.',
  },

  romance_scam: {
    playbook:
      'First they connect through a dating app, Facebook, Instagram, or a "wrong number" text, and over weeks or months build a relationship with constant messaging — but always too busy or traveling to video call. Then a crisis appears: a medical bill, a stuck shipment, a frozen bank account, a customs fee on a gift for you. Finally the asks compound, often escalating into pig-butchering crypto "opportunities" once rapport is total.',
    whyItWorks:
      'Real attachment forms even in fake relationships. Once you\'ve defended this person to your family and invested emotionally, admitting it\'s a scam feels like losing them twice.',
    redFlags: [
      'Never able to video call clearly or meet in person despite "falling in love."',
      'Claimed to be on an oil rig, in the military overseas, a doctor working abroad, or a widowed engineer.',
      'First money request was small and "urgent" — a test.',
      'Asked you to keep the relationship a secret from family.',
      'Money had to go by wire, gift card, or crypto, never a regular transfer.',
    ],
    stopItNow:
      'Stop sending money today, even if they double down on the story. Do a reverse-image search on their photos — most romance scammers reuse stolen images. Tell one trusted friend or family member, not to shame you but to break the isolation the scammer needs.',
  },

  pig_butchering: {
    playbook:
      'First a "wrong number" text or a dating-app match evolves into a warm, platonic-or-romantic relationship with daily chat over weeks or months. Then the new friend casually mentions their "uncle\'s" crypto or forex tips, walks you through a small deposit on a polished-looking platform, and lets you "withdraw" a small profit to build trust. Finally you\'re coached into larger deposits — sometimes retirement or home equity — and when you try to withdraw, the platform demands "taxes" or "release fees" that only grow; eventually the platform and the friend disappear.',
    whyItWorks:
      'This scam uses the entire social-engineering toolkit stacked on a long timeline: reciprocity, sunk cost, loneliness, FOMO, and staged early wins. By the time the biggest deposits are made, the victim genuinely believes they have a partner and a proven strategy.',
    redFlags: [
      'A stranger\'s "wrong number" text led to a months-long relationship you never met in person.',
      'They mentioned a mentor, uncle, or insider with special trading signals.',
      'The platform let you withdraw small amounts early — classic confidence-building.',
      'Withdrawal suddenly required "taxes," "liquidity fees," or a deposit to "unlock."',
      'You were coached to move retirement, home equity, or borrowed money into the platform.',
    ],
    stopItNow:
      'Stop all deposits today, no matter what the "fee to withdraw" story is — paying it never works; there is no real money to withdraw. Do not respond to the "friend." Report to the FBI\'s IC3 and keep every message, screenshot, wallet address, and transaction ID for law enforcement.',
  },

  parent_teacher_spoof: {
    playbook:
      'First you get a call with your child\'s school on the caller ID saying your child has been injured, had a seizure, or is in the principal\'s office. Then the "nurse," "officer," or "administrator" says you need to authorize transport, pay a fee, or come get them, and hands you off to an "officer" who pressures you not to hang up. Finally they push for a gift-card, Zelle, or wire payment "for the hospital co-pay" or "to release your child."',
    whyItWorks:
      'No parent hesitates when told their child is hurt. Caller-ID spoofing of the school\'s real number defeats the first instinct to verify.',
    redFlags: [
      'A school asking for money over the phone for a medical or transport fee.',
      'Caller would not let you hang up and call the school back.',
      'Refused to let you speak to your child or a teacher by name.',
      'Demanded gift card, Zelle, or wire payment.',
      'Used generic phrases like "your son" or "your daughter" without the name.',
    ],
    stopItNow:
      'Hang up and call the school\'s main office using the number from the district website or your contact list. No US school asks for payment by gift card, wire, or Zelle in an emergency.',
  },

  // ----- Financial ----------------------------------------------------
  zelle_venmo_support_scam: {
    playbook:
      'First, after you report a scam to Zelle, Venmo, or Cash App inside the app, a caller phones you claiming to be platform "support" (or Google-ranked fake support numbers you searched for). Then they walk you through a "refund verification" that requires sending money back to yourself — but the instructions put it in the scammer\'s account. Finally, they repeat the "test" with larger amounts, sometimes draining accounts further.',
    whyItWorks:
      'You\'re already rattled from being scammed once. "Support" calling you feels like help, not a second attack.',
    redFlags: [
      'Unsolicited callback from "Zelle / Venmo / Cash App support" after you reported a scam.',
      'Instructions to send money to yourself — these apps don\'t require that.',
      'A "senior support" tier that asks you to install remote-access software.',
      'Pressure to act before the transaction "times out."',
      'Phone number you got from a Google search ad, not the platform\'s in-app contact.',
    ],
    stopItNow:
      'Hang up. Contact support only through the in-app help center of Zelle, Venmo, or Cash App, and your bank for Zelle issues. Never send payments to "verify" a refund.',
  },

  bitcoin_atm_scam: {
    playbook:
      'First a scammer (impersonating IRS, SSA, a bank, or a sheriff) tells you your money is at risk and must be "deposited to a secure federal wallet" through a Bitcoin kiosk. Then they keep you on the phone while driving you to a specific kiosk at a gas station, laundromat, or convenience store. Finally they text you a QR code wallet address; you feed cash into the kiosk and scan their code, sending the coins directly to them in seconds.',
    whyItWorks:
      'The target thinks the kiosk is a government tool because the caller describes it that way. Staying on the phone prevents any employee or bystander from breaking the spell.',
    redFlags: [
      'Any instruction to deposit cash into a Bitcoin ATM to "protect" or "verify" your money.',
      'A QR code texted to you to scan at the kiosk.',
      'Told to tell the store clerk the money is for "family" or a "car purchase" if asked.',
      'Told to stay on the phone while driving and during the deposit.',
      'Agency, bank, or officer instructing the trip — none use crypto kiosks.',
    ],
    stopItNow:
      'Stop. No US government agency, bank, or law enforcement will ever ask you to deposit cash into a Bitcoin ATM. If you\'re at a kiosk now, walk away and call 911 or your bank. If you already sent coins, save the receipt (it has a transaction ID) and report immediately — kiosk operators occasionally can halt a transfer that is still pending.',
  },

  gift_card_scam: {
    playbook:
      'First the caller (IRS, utility, "Amazon fraud," grandchild\'s lawyer, whoever) creates a crisis and says the only fast fix is to pay by gift card. Then they instruct you to drive to Target, Walmart, Walgreens, or a grocery store and buy specific brands (Apple, Google Play, Target, Amazon, eBay) in specific denominations, splitting the purchase across stores to avoid cashier questions. Finally you read them the activation codes off the back of each card, and within minutes the value is drained to overseas resellers.',
    whyItWorks:
      'Gift cards feel mundane and anonymous — they don\'t trigger the same hesitation as wiring money — and most cashiers have no scripted way to stop a customer who insists.',
    redFlags: [
      'Any agency or company taking payment by Apple, Google Play, Amazon, Target, or Walmart gift cards.',
      'Instructed to split purchases across multiple stores.',
      'Told what to say to the cashier if they ask.',
      'Told to read card numbers or photograph the back of the cards.',
      'Stayed on the phone with you during the drive and the purchase.',
    ],
    stopItNow:
      'Stop buying. If the cards are still in your hand and unread, call each issuer\'s gift-card fraud line printed on the card\'s packaging — some can freeze the balance if the codes haven\'t been redeemed yet. Then call your local police non-emergency line.',
  },

  investment_scam: {
    playbook:
      'First you see an ad, WhatsApp group, or "signals" Telegram channel promising outsized returns — often crypto, forex, precious metals, or pre-IPO shares. Then a "broker" or "analyst" walks you through depositing on a slick platform that shows rapid gains and lets you make a small withdrawal as proof. Finally, larger deposits get locked behind "taxes," "liquidity fees," or "regulatory holds" that never release.',
    whyItWorks:
      'A staged early win is the most effective tool in the scam toolkit — it shifts your stance from cautious to greedy, which is the exact switch the rest of the con needs.',
    redFlags: [
      'Guaranteed returns, "no-risk" trades, or promises of specific percentages.',
      'Unregistered broker, platform, or advisor.',
      'A first small withdrawal worked; later ones require fees.',
      'Encouraged you to move retirement funds, home equity, or borrowed money.',
      'Pressure to invest within a specific tight window "before the opportunity closes."',
    ],
    stopItNow:
      'Stop all deposits. Check the broker\'s registration on FINRA BrokerCheck or the SEC\'s EDGAR. Keep all screenshots, wallet addresses, and transaction IDs and report to the FBI\'s IC3 and your state securities regulator.',
  },

  crypto_scam: {
    playbook:
      'First the hook comes through a giveaway tweet, a fake wallet support call, an airdrop site, or a DM from a fake exchange "agent." Then you\'re walked into connecting a wallet, signing a malicious transaction, or handing over your seed phrase "to verify." Finally, tokens and NFTs are drained from the wallet in a single transaction, often with a second attempt minutes later.',
    whyItWorks:
      'Crypto UX is confusing even for experienced users. Signing a transaction feels like clicking "ok"; seed phrases feel like passwords you might share with support — but they are master keys.',
    redFlags: [
      'Anyone asking for your seed phrase or recovery words — no legitimate service ever needs these.',
      '"Support" reaching out to you first, especially on Telegram, Discord, or by phone.',
      'Airdrop or wallet-connect page that required an unusual signature.',
      'Requested you import a new wallet using a seed phrase they provided.',
      'Told you must "sync" your wallet to fix an error.',
    ],
    stopItNow:
      'Move any remaining funds to a brand-new wallet with a seed phrase generated offline. Revoke token approvals (use a reputable revoke tool) and assume any compromised wallet is permanently burned. Never enter a seed phrase into anything but your own wallet software.',
  },

  coinbase_support_spoof: {
    playbook:
      'First you get a call, text, or email claiming to be Coinbase Security about "unauthorized access" or "a withdrawal from a new device." Then the "agent" walks you to a cloned login page, asks for your email, password, and 2FA, or tells you to move your coins to a "Coinbase Vault address" for safety. Finally, any coins you move go to the attacker\'s wallet and are gone instantly.',
    whyItWorks:
      'Coinbase does not offer unsolicited phone support, but most users don\'t know that; and seeing "Coinbase" on the caller ID is enough to bypass skepticism.',
    redFlags: [
      'An inbound call claiming to be Coinbase Support (Coinbase does not cold-call customers).',
      'Asked for your password, 2FA code, or seed phrase.',
      'Told you to move coins to a "vault" or "safe" wallet address they gave you.',
      'Texted you a link to log in to "verify" your identity.',
      'Pressured you to act within minutes before "the hacker drains your account."',
    ],
    stopItNow:
      'Hang up. Log into Coinbase directly from the official app, change your password, enable hardware or app-based 2FA (not SMS), and review recent sends. If any have gone out, report via the Coinbase help flow in-app.',
  },

  debt_collection_phantom: {
    playbook:
      'First they call about an old payday loan, credit card, or utility bill you don\'t recognize — or that you paid off years ago. Then they cite your SSN, old address, or employer to prove it\'s "real" and threaten wage garnishment, arrest, or a lawsuit by end of day. Finally they push for payment today by gift card, prepaid card, or wire, bypassing the normal written-notice requirements.',
    whyItWorks:
      'Fear of a lawsuit plus authentic-sounding personal details (from old data breaches) make the debt feel legitimate, even when it isn\'t.',
    redFlags: [
      'No written validation notice before the call — illegal under the FDCPA.',
      'Threats of arrest, wage garnishment, or deportation for a debt.',
      'Demanded payment by gift card, prepaid card, or wire.',
      'Refused to name the original creditor or provide their collector license.',
      'Called repeatedly outside 8 a.m. to 9 p.m. or at your workplace after you said stop.',
    ],
    stopItNow:
      'Do not pay. Ask in writing for a debt validation letter — you have the right to one under federal law, and phantom collectors can\'t produce it. Pull your credit reports at annualcreditreport.com to see if the debt exists at all, and report the caller to the CFPB and your state AG.',
  },

  car_warranty_expiration: {
    playbook:
      'First a robocall or live caller says your vehicle\'s manufacturer warranty is about to expire and they are calling from "the warranty center" for your specific make and model. Then a "specialist" collects your VIN, mileage, and card info to enroll you in extended coverage for hundreds or thousands of dollars. Finally, either nothing is delivered, or a worthless third-party service contract is issued that denies nearly every claim.',
    whyItWorks:
      'Most drivers don\'t know whether their warranty is active, and the caller sounds specific enough (make, model, mileage) to be plausible.',
    redFlags: [
      'Robocall or cold call about your specific car "warranty expiring."',
      'Asked for VIN, mileage, and card info on the same call.',
      'Wouldn\'t name the underwriter in writing before charging you.',
      'High-pressure "today only" pricing.',
      'The caller can\'t tell you anything about your vehicle they couldn\'t have bought from a data broker.',
    ],
    stopItNow:
      'Hang up. If you want extended coverage, buy it through your manufacturer or a reputable provider you chose yourself, and read the contract before paying. If you already paid, dispute the charge with your card issuer within 60 days.',
  },

  home_warranty_scam: {
    playbook:
      'First a mailer or call tells you your "home warranty is about to expire" — usually right after you buy a house and your name hits public records. Then they pitch a home service plan that supposedly covers HVAC, appliances, and plumbing with a low monthly fee and a one-time activation payment. Finally, either the company doesn\'t exist, denies every claim as "pre-existing," or charges a steep cancellation fee when you try to leave.',
    whyItWorks:
      'New homeowners are overwhelmed and genuinely anxious about surprise repair bills. The official-looking mailer uses fake urgency and a real address pulled from public records.',
    redFlags: [
      'Mailer or call within weeks of closing on a home, addressed to the exact owner name.',
      'Claimed to be affiliated with your builder, realtor, or lender without proof.',
      'Demanded an activation fee up front.',
      'No written contract before payment.',
      'Exclusions in the fine print that make nearly every claim "pre-existing."',
    ],
    stopItNow:
      'Don\'t pay. Research home warranty companies with your state consumer protection office or BBB, and compare policies from multiple providers. If you already paid, dispute it with your card and file a complaint with your state attorney general.',
  },

  subscription_trap: {
    playbook:
      'First you see a "free trial" for a skincare sample, diet product, software suite, or streaming service that only asks for a small shipping fee. Then the terms buried in the fine print authorize monthly charges starting immediately, often at $80 to $200 each. Finally, when you try to cancel, the company hides the cancellation path, requires phone-only cancellation, or charges a steep "restocking" fee.',
    whyItWorks:
      '"Free" with a shipping fee feels like near-zero risk. The dark pattern in the fine print is designed specifically to bypass the reader.',
    redFlags: [
      '"Free trial" that required a credit card for shipping.',
      'Impossible-to-find cancellation page or cancellation required by phone only.',
      'Charges that started before the trial was over.',
      'Charges under a different, unfamiliar merchant name.',
      'Restocking or cancellation fee disproportionate to the product.',
    ],
    stopItNow:
      'Dispute the charges with your card issuer as "recurring charges I didn\'t authorize." Cancel the card if the merchant keeps re-billing. Screenshot the cancellation flow to prove they made it inaccessible.',
  },

  advance_fee_inheritance: {
    playbook:
      'First you get a letter, email, or call saying a distant relative or foreign dignitary died and left you a large inheritance — or that you\'re entitled to a humanitarian relief payout. Then a "lawyer," "bank officer," or "customs agent" needs you to prepay taxes, legal fees, or transfer fees to release the funds. Finally, fees compound: each payment unlocks a new "final" fee, and the inheritance never arrives.',
    whyItWorks:
      'The prospect of life-changing money rewires risk assessment. And once you\'ve paid the first fee, sunk cost keeps you paying the next.',
    redFlags: [
      'A relative or benefactor you\'ve never heard of left you money.',
      'You must pay fees up front before receiving funds — real estates deduct fees from the distribution.',
      'The "attorney" or "bank" uses free email addresses (gmail, outlook).',
      'Each "final fee" is followed by another.',
      'Heavy use of titles and official-sounding departments that don\'t actually exist.',
    ],
    stopItNow:
      'Stop paying. Legitimate inheritances never require you to pay to receive them. If funds were wired internationally, contact your bank immediately — a recall is only possible in a narrow window.',
  },

  lottery_sweepstakes: {
    playbook:
      'First you get a call, letter, or Facebook message saying you\'ve won Publishers Clearing House, a state lottery, or an international sweepstakes. Then they tell you must prepay taxes, IRS fees, customs, or insurance to release the prize — often by gift card, wire, or check (the check bounces later). Finally, either nothing arrives, or a follow-up demands another fee "because a second prize was added."',
    whyItWorks:
      'The excitement of winning plus confusion about tax rules (you might actually owe taxes on real winnings) make the request feel normal.',
    redFlags: [
      'You never entered the lottery or sweepstakes you "won."',
      'Required to pay fees up front — real prizes deduct taxes, they don\'t collect them by gift card.',
      'Told to keep the win confidential "until funds clear."',
      'PCH reps showing up at your door — real PCH only does this for the big ones and never asks for payment.',
      'Caller used a free email or a foreign phone number.',
    ],
    stopItNow:
      'Don\'t pay. Hang up. If you think you might have actually entered a sweepstakes, verify directly through the sponsor\'s official website.',
  },

  // ----- Services / property ------------------------------------------
  employment_scam: {
    playbook:
      'First a recruiter messages you on LinkedIn, Indeed, or text about a remote job — data entry, package reshipping, payment processing, personal assistant, or mystery shopping. Then the "onboarding" asks for your SSN, driver\'s license, and bank info "for payroll," and sometimes a check you\'re told to deposit and forward as "equipment reimbursement." Finally, either the check bounces leaving you on the hook, or you become a money mule moving stolen funds and goods through your own accounts.',
    whyItWorks:
      'Job-seekers are motivated and often under financial pressure. The legitimacy cover of LinkedIn plus a real company name (usually spoofed) bypasses early skepticism.',
    redFlags: [
      'Hired without a real video interview or HR paperwork.',
      'Asked for SSN, license, and bank info before any signed offer.',
      'Sent you a check to deposit and "forward" to a vendor.',
      'Asked you to reship packages from addresses you didn\'t buy from.',
      'Communicated only over text, WhatsApp, Telegram, or personal Gmail.',
    ],
    stopItNow:
      'Stop all communication. Do not deposit any check they sent — the funds will claw back days later and leave you liable. Report identity-related info you shared to IdentityTheft.gov. If you reshipped packages, contact USPIS.',
  },

  rental_scam: {
    playbook:
      'First you find a too-good-to-be-true listing on Craigslist, Zillow, or Facebook Marketplace — often a real property scraped from a real agent\'s listing with a new "owner" email. Then the "owner" claims to be overseas and can\'t show the property but will mail keys after you wire a deposit and first month\'s rent. Finally, you send the money and either get nothing back or show up to a property that isn\'t for rent.',
    whyItWorks:
      'Tight housing markets make "act fast" pressure feel genuine, and photos of a real property (stolen from the real listing) defeat the usual image-check.',
    redFlags: [
      'Owner "out of the country" and can\'t show the unit.',
      'Asked for wire, Zelle, or crypto for deposit — not a normal rental payment.',
      'Rent far below comparable units in the neighborhood.',
      'Pressured to pay before a walk-through or lease signing.',
      'Listing photos matched a real for-sale or rented-elsewhere property (reverse image search).',
    ],
    stopItNow:
      'Don\'t send money. Verify the property through public records for the real owner\'s name, or contact the listing agent on the original site. If you already wired, call your bank immediately — recalls are possible if funds haven\'t settled.',
  },

  timeshare_resale: {
    playbook:
      'First a company contacts current timeshare owners (names and properties are publicly searchable) claiming a buyer is "ready to close" on their unit for a premium price. Then they demand an upfront "closing fee," "transfer tax," or "title escrow" payment — often several thousand dollars. Finally, the buyer vanishes, and a second "recovery" company often calls offering to get the lost fee back for another fee.',
    whyItWorks:
      'Timeshare owners are often desperate to exit and will rationalize fees that don\'t match a real resale process.',
    redFlags: [
      'Unsolicited call claiming a buyer is already lined up for your specific unit.',
      'Upfront fees before any contract or closing — real resales pay out of the sale proceeds.',
      'Pressured to pay today "before the buyer walks."',
      'No verifiable license number or brokerage.',
      'Follow-up call from a "recovery" company after the first fee disappears.',
    ],
    stopItNow:
      'Don\'t pay upfront. Verify any broker with your state real estate commission and the FTC\'s timeshare resale guidance. Real exits take months and don\'t require up-front money.',
  },

  solar_panel_scam: {
    playbook:
      'First a door-knocker or cold caller pitches "free" solar panels or a government-subsidized install with zero cost to you. Then they pressure you to sign a financing agreement on a tablet that day, sometimes misrepresenting it as a utility enrollment. Finally you\'re locked into a 20-year loan at high interest for panels that may not generate the promised savings or may never be installed.',
    whyItWorks:
      'High utility bills make savings pitches compelling, and the signature-on-tablet UX hides the real terms behind friendly language.',
    redFlags: [
      'Door-to-door or cold-call solar pitch with a "today only" discount.',
      'Asked to sign on a tablet without a printed copy of the contract.',
      'Claimed "free panels" or "government program" with no cost.',
      'Misrepresented monthly cost or projected savings.',
      'Financing company not clearly named at signing.',
    ],
    stopItNow:
      'Do not sign anything on a tablet without reading the full contract in PDF first. Most states give you a cancellation window — typically three days — so check your state rules and cancel in writing immediately. File with your state attorney general.',
  },

  moving_company_hostage: {
    playbook:
      'First an online broker quotes you a suspiciously low price for a long-distance move and takes a deposit. Then a day-of crew (not the company you booked) loads your belongings and on the way out revises the price sharply upward "based on actual weight." Finally, if you refuse to pay, they drive off with your belongings and demand payment plus storage fees to release them.',
    whyItWorks:
      'Everything you own is already on the truck. The leverage is absolute and the time pressure (you need your stuff at the new home) forces a bad decision.',
    redFlags: [
      'Quote far below other movers for the same route.',
      'Deposit required before an in-person or video survey.',
      'No USDOT number on the truck or the paperwork.',
      'Crew that showed up wasn\'t the company you booked with.',
      'Price revised upward after loading, with storage threats if unpaid.',
    ],
    stopItNow:
      'File a complaint with the FMCSA\'s National Consumer Complaint Database immediately and your state AG. Federal regulations limit how much movers can withhold for a price dispute — do not pay cash, pay by credit card so you can dispute, and document everything.',
  },

  home_repair_storm_chaser: {
    playbook:
      'First a contractor shows up door-to-door after a hailstorm, hurricane, or tornado offering "free inspections." Then they "find" significant roof, siding, or tree damage and demand a big deposit for repairs, often bundling in insurance-claim assistance. Finally, either the work is never done, done badly, or they disappear with the deposit and any insurance check endorsed to them.',
    whyItWorks:
      'Post-disaster anxiety and legitimate backlog at reputable contractors push homeowners to hire whoever shows up first.',
    redFlags: [
      'Door-to-door contractor immediately after a storm, with no local office you can verify.',
      'Large deposit required before work begins.',
      'Offered to sign over your insurance claim to them ("assignment of benefits").',
      'Out-of-state license plates and no local references.',
      'Pressured you to decide within 24 hours "before prices go up."',
    ],
    stopItNow:
      'Stop. Don\'t sign anything today. Verify the contractor\'s license with your state\'s contractor licensing board and get two written bids from locally established contractors before signing. Never endorse an insurance check directly to a contractor.',
  },

  funeral_cremation_scam: {
    playbook:
      'First, during or just after a death, a funeral home or third-party "services" company adds undisclosed fees, upsells caskets or urns, or invents permits and filing charges. Then, in some cases, a scammer impersonating a funeral home calls the family claiming additional payment is needed to release the body or complete cremation. Finally the family — exhausted and grieving — pays rather than argue.',
    whyItWorks:
      'Grief collapses scrutiny, and few people have funeral-industry experience to benchmark against.',
    redFlags: [
      'Fees added after the initial itemized estimate — the FTC Funeral Rule requires an upfront itemized price list.',
      'Mandatory packages with no a la carte option.',
      'Phone demand for immediate payment to "release" remains.',
      'High-pressure casket or urn upsells at the viewing.',
      'Cremation service not licensed in your state.',
    ],
    stopItNow:
      'Ask for the Funeral Rule itemized price list in writing — federal law requires it. Bring a non-grieving friend or family member to review charges before signing. Report overcharging to the FTC and your state funeral board.',
  },

  pet_scam: {
    playbook:
      'First you find an adorable puppy or kitten online at a price below comparable breeders, often from a site with stolen photos and a polished design. Then the "breeder" asks for a deposit by Zelle, Cash App, or wire, and after you pay, a "transport company" charges extra for a crate, climate-controlled shipping, insurance, and customs. Finally the pet never arrives and each new fee opens the door to another.',
    whyItWorks:
      'Attachment forms the moment you see the photo and name the pet. Fees feel like the cost of getting your new family member home.',
    redFlags: [
      'Price well below comparable breeders.',
      'Breeder refuses video calls of the specific animal.',
      'Payment demanded by Zelle, Cash App, wire, or gift card.',
      'Reverse image search shows the puppy\'s photo on many unrelated sites.',
      'Shipping fees compounding after the deposit.',
    ],
    stopItNow:
      'Stop paying — every new fee is part of the same scam. If money was wired, call your bank for a recall. Report to the BBB and IC3 and save all screenshots for law enforcement.',
  },

  // ----- Health / benefits / education --------------------------------
  student_loan_forgiveness: {
    playbook:
      'First a caller or ad promises to "forgive" your federal student loans, lower payments to $0, or get you into a special program "only available today." Then they charge an upfront fee of $400 to $1,500 or a monthly "service" fee, sometimes asking for your FSA ID credentials "to process it." Finally they either do nothing, sign you up for a free program you could have done yourself, or change your FSA password and redirect refunds.',
    whyItWorks:
      'Federal student-loan rules change often and are genuinely confusing. "Limited-time" urgency exploits that confusion.',
    redFlags: [
      'Any company charging an upfront fee to forgive federal loans — federal forgiveness is free to apply for.',
      'Asked for your FSA ID (login for studentaid.gov).',
      'Claimed access to a "secret" Biden / Trump / Department of Education program.',
      'Told you must act "before the window closes."',
      'Took a power-of-attorney that let them collect your refunds.',
    ],
    stopItNow:
      'Do not pay. Apply for any forgiveness or repayment plan directly at studentaid.gov — it\'s always free. If you gave up your FSA ID, change the password today and revoke any POA on file.',
  },

  veterans_benefits_buyout: {
    playbook:
      'First a "pension advance" or "VA benefits buyout" firm targets veterans with disability or pension benefits and offers a lump-sum cash payment in exchange for signing over future monthly payments. Then the effective interest rate — not disclosed clearly — often exceeds 100% APR. Finally the veteran is locked into years of assigned benefits while the firm collects many times the lump sum.',
    whyItWorks:
      'Short-term cash need plus complex disclosures in fine print. Many veterans are unaware that federal law prohibits assigning VA benefits.',
    redFlags: [
      'Offer of a lump sum in exchange for future VA or military pension payments.',
      'APR not clearly disclosed or hidden behind "not a loan" language.',
      'Required you to open a joint bank account the lender also controls.',
      'Unsolicited mail or call — legitimate VA assistance is through accredited VSOs.',
      'Asked for a durable power of attorney tied to your benefits.',
    ],
    stopItNow:
      'Don\'t sign. Federal law generally prohibits assignment of VA benefits. Talk to an accredited Veterans Service Organization (VFW, American Legion, DAV) or the VA\'s own benefits line for free help.',
  },

  affordable_care_act_scam: {
    playbook:
      'First a caller claims to be from "the Marketplace," "Obamacare," or "Biden Care" and offers plans below market rate or a subsidy you qualify for only by calling back today. Then they ask for your SSN, income estimate, date of birth, and bank info to "enroll" you. Finally they either steal the identity info, sign you up for a worthless fixed-indemnity plan misrepresented as full ACA coverage, or both.',
    whyItWorks:
      'Health insurance is confusing and expensive. Anything that sounds like free subsidy money gets a hearing.',
    redFlags: [
      'Unsolicited call about "Biden Care," "Obamacare," or a "new subsidy program."',
      'Asked for SSN, income, and bank info before showing any written plan.',
      'Plan offered was far cheaper than anything on HealthCare.gov.',
      'Couldn\'t explain whether it was an ACA-compliant plan or a fixed-indemnity product.',
      'Told you must act today or "lose the subsidy."',
    ],
    stopItNow:
      'Hang up. Shop ACA plans only at HealthCare.gov (or your state exchange) or through a licensed broker you chose. Report the call to your state insurance department.',
  },

  tax_prep_identity_theft: {
    playbook:
      'First a "preparer" offers big refunds through a pop-up office, Facebook ad, or door-to-door outreach, promising far more than competitors. Then they collect your SSN, W-2s, and direct-deposit info and file a return with fabricated dependents, credits, or withholding. Finally, the refund goes to an account they control, or you later discover a fraudulent return was filed in your name and the real refund is locked.',
    whyItWorks:
      'Big-refund promises exploit cash-tight taxpayers. Many targets never see their own return before it\'s e-filed.',
    redFlags: [
      'Preparer refused to sign the return or provide a PTIN (required by the IRS).',
      'Promised refunds far above competitors with no explanation.',
      'Directed refund to an account you don\'t control.',
      'Wouldn\'t give you a copy of the filed return.',
      'Charged a percentage of the refund instead of a flat fee.',
    ],
    stopItNow:
      'Request a copy of your filed return today and check it against IRS transcripts at the IRS\'s official site. If a fraudulent return was filed, file IRS Form 14039 (Identity Theft Affidavit) and place a fraud alert on your credit reports.',
  },

  // ----- Civic / seasonal ---------------------------------------------
  charity_scam: {
    playbook:
      'First you get a call, text, email, or social post seeking donations for a cause you care about — often tied to a recent disaster, holiday drive, veterans\' fund, police benevolent association, or a sick child. Then they push you to donate now by card, gift card, or crypto. Finally, the charity either doesn\'t exist, is registered but spends almost nothing on the cause, or is a direct impersonation of a real charity with a sound-alike name.',
    whyItWorks:
      'Empathy plus timing (disaster, holiday) plus a sound-alike name defeats the skepticism people would apply to any other kind of cold call.',
    redFlags: [
      'Name very similar to a well-known charity but not identical.',
      'Refused to provide EIN or state registration number.',
      'Pressured you to give today by phone rather than letting you look them up.',
      'Accepted gift cards or crypto for donations.',
      'Couldn\'t say what percentage of donations go to program vs. overhead.',
    ],
    stopItNow:
      'Don\'t donate on the phone. Verify the charity on Charity Navigator, GuideMe, or your state\'s charity registry, then give directly on the charity\'s official website.',
  },

  political_donation_scam_pac: {
    playbook:
      'First you get a call, text, or email aligning with your political views asking for donations to a candidate, PAC, or "emergency defense fund." Then the messaging uses matching-gift language ("your donation will be 500% matched today") and rapid follow-up prompts. Finally, the money goes to a "scam PAC" that spends almost nothing on political activity, keeps recurring charges running, or uses your card for test fraud charges elsewhere.',
    whyItWorks:
      'Political identity is a strong lever, and urgency is baked into political fundraising anyway, so real and fake campaigns use the same language.',
    redFlags: [
      'PAC or committee name sounds political but you can\'t find real campaign activity.',
      'Recurring donations enabled by default with a small, hidden opt-out.',
      'Donation links went to third-party processors instead of the campaign\'s own site.',
      'Match claims that defy the math ("500% matched").',
      'Follow-up calls asking for more within hours of the first gift.',
    ],
    stopItNow:
      'Check the committee at the FEC\'s website and review your card statement for recurring charges you didn\'t intend. Donate only via the candidate\'s or organization\'s own verified site.',
  },

  census_survey_scam: {
    playbook:
      'First a caller says they\'re from the US Census Bureau conducting a "short survey" or "verification." Then they ask for SSN, bank account details, full DOB, and income — questions the real Census never asks by phone. Finally the info is used for identity theft, credit applications, or sold on to other fraudsters.',
    whyItWorks:
      'Civic duty + an official-sounding agency pushes compliance, and most people have never interacted with the Census and don\'t know what they do and don\'t ask.',
    redFlags: [
      'Asked for your SSN, bank account, or credit card — the Census never asks for these.',
      'Threatened a fine for not answering.',
      'Refused to provide a supervisor name or call-back number at the Census Bureau.',
      'Used a robocall opener pressing you to a live agent.',
      'Call came outside normal Census survey cycles or regions.',
    ],
    stopItNow:
      'Hang up. Verify any survey by calling the Census Bureau\'s official regional office from their official website. Real Census workers will have an ID badge and can be verified by phone.',
  },

  fema_disaster_relief_fraud: {
    playbook:
      'First, after a federally declared disaster, a "FEMA inspector" or "relief agent" calls or visits offering to fast-track your application for a fee. Then they ask for your SSN, bank info, and disaster case number "to expedite the grant." Finally, they either steal the identity info, collect the fee, or submit a fraudulent application in your name and redirect the payout.',
    whyItWorks:
      'Disaster victims are exhausted and confused about the aid process, and a helper-figure with official-sounding language is hard to refuse.',
    redFlags: [
      'Any "FEMA" representative charging a fee — FEMA assistance is free.',
      'Asked for your SSN and bank info in the same in-person or phone interaction.',
      'Used generic badges without a visible federal agency ID.',
      'Showed up to high-damage neighborhoods door-to-door offering fast-track service.',
      'Pressured you to sign a contract with a specific contractor on the spot.',
    ],
    stopItNow:
      'Stop. Apply for FEMA assistance only at disasterassistance.gov or the official FEMA helpline. Never pay anyone to apply for you. Report suspected fraud to the FEMA disaster fraud hotline.',
  },

  // ----- Text / smishing ----------------------------------------------
  package_redelivery: {
    playbook:
      'First you get a text from "USPS," "UPS," "FedEx," or "DHL" saying a package couldn\'t be delivered because of an address issue or small customs/redelivery fee. Then a link in the text takes you to a clone of the carrier\'s tracking page where you enter your address and card info for a small fee. Finally, the card is used immediately for test charges and then larger ones, and the address info is added to a profile for future scams.',
    whyItWorks:
      'Most people have a package in transit at any given moment, which makes the text feel personalized when it isn\'t.',
    redFlags: [
      'USPS, UPS, or FedEx never text about a redelivery fee for a domestic package.',
      'Link domain didn\'t match the carrier\'s real domain.',
      'Small urgent fee asked over text.',
      'Text came from an email address or an unusual phone number.',
      'Page asked for full card info rather than routing to the carrier\'s real app.',
    ],
    stopItNow:
      'Don\'t tap the link. If you\'re expecting a package, go to the carrier\'s real app or official site and paste the tracking number there. Report USPS smishing to the US Postal Inspection Service at their official reporting page.',
  },

  unpaid_toll: {
    playbook:
      'First you get a text from "E-ZPass," "SunPass," "FasTrak," or your state\'s toll authority saying you have an unpaid toll of a small amount ($4 to $14) and will face late fees or license suspension if not paid within 24 hours. Then a link takes you to a cloned agency page that collects your card details and sometimes driver\'s license info. Finally the card is drained through rapid test purchases while the identity info is resold.',
    whyItWorks:
      'Small amount + plausible authority + short window is a textbook phishing combo. It\'s cheaper to pay $12 than to argue, which is exactly what the scammers count on.',
    redFlags: [
      'Link domain didn\'t match your actual toll agency\'s real domain.',
      'Text threatened license suspension over a $10 toll.',
      'Demanded payment within hours.',
      'Text came from an email or overseas number.',
      'Wouldn\'t accept payment through the toll agency\'s real app.',
    ],
    stopItNow:
      'Don\'t tap the link. Go directly to your toll agency\'s real app or website to check for any actual outstanding toll. Report the text to your state toll authority and forward it to 7726 (SPAM) on your phone.',
  },

  // ----- Re-victimization ---------------------------------------------
  recovery_scam_secondary: {
    playbook:
      'First a caller reaches you shortly after a scam loss — often within weeks — having bought your info from a "sucker list" sold between scammers. Then they claim to be a federal recovery task force, a law firm, a crypto tracing expert, or a licensed asset recovery company that can get your money back for an upfront retainer or "blockchain analysis fee." Finally they take the fee and either vanish or drip-feed fake progress updates to extract more money over months.',
    whyItWorks:
      'The victim is grieving and desperate, and the idea that someone finally has answers is irresistible. Scammers know that anyone who paid once has proved willing to pay again under the right frame.',
    redFlags: [
      'Unsolicited contact about your exact previous scam loss — only a scammer or that scammer\'s network would know.',
      'Demanded upfront retainer, "blockchain fee," or "court filing fee."',
      'Claimed to be affiliated with a government agency doing recovery for you.',
      'Promised specific recovery amounts or timelines.',
      'Asked for remote access to your computer to "view" your wallet.',
    ],
    stopItNow:
      'Do not pay them anything. Legitimate recovery (through your bank, FBI IC3, or a licensed attorney you hired) does not cold-call victims. If you\'ve lost money, file with IC3 at ic3.gov and with the FTC at reportfraud.ftc.gov for free.',
  },

  // ----- Meta ---------------------------------------------------------
  unknown_triage: {
    playbook:
      'You\'re in pre-scam triage — we don\'t know yet exactly what happened, only that something felt off. Almost every phone or online scam runs the same arc: the caller builds pressure, asks you to keep it secret, and pushes you toward moving money or sharing a code. I\'ll ask a few gentle questions so we can see whether what happened to you fits a known pattern, and so we can protect what matters next.',
    whyItWorks:
      'Scams work when the target is isolated, rushed, and emotionally activated. You\'re now out of the pressure moment, which is the single best position to think clearly — no matter what decisions were made in the moment.',
    redFlags: [
      'The caller told you to stay on the phone and not talk to anyone else.',
      'There was a countdown, a "today only," or a threat of arrest/loss.',
      'You were asked to move money, buy gift cards, share a code, or install software.',
      'The caller claimed to be from an agency or company that somehow knew real details about you.',
      'Something in your gut told you it didn\'t add up, even as you complied.',
    ],
    stopItNow:
      'You\'re safe right now — take a breath. If any money, codes, or remote access were shared in the last hour, the fastest protective action is calling your bank on the number from the back of your card and changing passwords on email and banking from a trusted device.',
  },

  generic: {
    playbook:
      'We know this was a scam but not yet the specific playbook. What almost all scams share: an opening hook (caller ID spoof, fake alert, or warm stranger), pressure (urgency, fear, or affection), and an extraction step (money, credentials, or a 2FA code). Naming where in that arc you are now helps us decide what to protect first.',
    whyItWorks:
      'Scammers don\'t need a new script every time — they reuse the same emotional levers (urgency, authority, secrecy, reciprocity) because those levers work on careful people under pressure.',
    redFlags: [
      'Unsolicited contact with a crisis you\'d never heard of until they called.',
      'Instructed to keep the situation secret from your family or bank.',
      'Asked for money, a code, remote access, or personal info under time pressure.',
      'Payment methods that legitimate businesses never use (gift cards, crypto, wire to a stranger).',
      'Caller refused to let you hang up and call back on a verified number.',
    ],
    stopItNow:
      'Hang up or close the tab. Don\'t send more money, don\'t share more codes, don\'t give more remote access. Call your bank on the number from your card and change passwords on email and banking from a device you trust.',
  },
};

// Legacy aliases — older recovery_sessions rows may still carry these
// strings. Keep them pointing at the modern keys so lookups stay stable.
SCAM_MECHANICS.romance = SCAM_MECHANICS.romance_scam!;
SCAM_MECHANICS.investment = SCAM_MECHANICS.investment_scam!;

export function describeScamMechanics(
  type: string | null | undefined,
): ScamMechanics | null {
  if (!type) return null;
  return SCAM_MECHANICS[type] ?? null;
}
