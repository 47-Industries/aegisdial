// Recovery step template catalog — v3 (52 scam types)
//
// Taxonomy sourced from authoritative 2024–2026 reporting:
//  - FTC Consumer Sentinel Network Data Book 2024 ($12.5B losses)
//  - FBI IC3 2024/2025 annual reports ($16.6B → $20.9B losses)
//  - BBB Scam Tracker 2024 Risk Report
//  - AARP Fraud Watch Network biggest-scams-for-2026
//  - FCC, FinCEN/OFAC joint notices, USPIS, FMCSA, VA OIG, HHS-OIG
//  - FBI Operation Level-Up (pig-butchering recall program)
//
// Phone numbers + URLs verified 2026-04-18. Surface with a
// "verify on the back of your card" disclaimer on the iOS side.
//
// Ordering matters: the app surfaces one step at a time, so the most
// time-sensitive action goes first. Steps flagged `time_sensitive: true`
// are hoisted above the rest when the user reports money lost and the
// session is newer than 24 hours old.

export type ScamType =
  // Impersonation — who
  | 'bank_impersonation'
  | 'bank_employee_impersonation'
  | 'irs_impersonation'
  | 'irs_refund_bait'
  | 'ssa_impersonation'
  | 'law_enforcement_impersonation'
  | 'fbi_dea_impersonation'
  | 'uscis_ice_impersonation'
  | 'digital_arrest'
  | 'medicare_impersonation'
  | 'medicare_advantage_switch'
  | 'utility_shutoff'
  // Tech / credential theft
  | 'tech_support'
  | 'fake_refund_scam'
  | 'apple_icloud_locked'
  | 'google_account_takeover'
  | 'sim_swap_port_out'
  | 'banking_app_push_bombing'
  | 'quishing_qr_phishing'
  | 'clickfix_malware'
  | 'coinbase_support_spoof'
  // Emotional — family / relationships / crisis
  | 'grandchild_emergency'
  | 'ai_voice_clone_family'
  | 'virtual_kidnapping'
  | 'sextortion'
  | 'romance_scam'
  | 'pig_butchering'
  | 'parent_teacher_spoof'
  // Financial — money out
  | 'zelle_venmo_support_scam'
  | 'bitcoin_atm_scam'
  | 'gift_card_scam'
  | 'investment_scam'
  | 'crypto_scam'
  | 'brokerage_401k_phishing'
  | 'debt_collection_phantom'
  | 'car_warranty_expiration'
  | 'home_warranty_scam'
  | 'subscription_trap'
  | 'advance_fee_inheritance'
  | 'lottery_sweepstakes'
  // Services / property
  | 'employment_scam'
  | 'rental_scam'
  | 'timeshare_resale'
  | 'solar_panel_scam'
  | 'moving_company_hostage'
  | 'home_repair_storm_chaser'
  | 'funeral_cremation_scam'
  | 'pet_scam'
  // Health / benefits / education
  | 'student_loan_forgiveness'
  | 'veterans_benefits_buyout'
  | 'affordable_care_act_scam'
  | 'tax_prep_identity_theft'
  // Civic / seasonal
  | 'charity_scam'
  | 'political_donation_scam_pac'
  | 'census_survey_scam'
  | 'fema_disaster_relief_fraud'
  // Text / smishing
  | 'package_redelivery'
  | 'unpaid_toll'
  // Re-victimization warning
  | 'recovery_scam_secondary'
  // Triage — victim unsure whether what happened was a scam yet.
  | 'unknown_triage'
  | 'generic'
  // Legacy aliases preserved so old recovery_sessions rows still load.
  | 'romance'
  | 'investment';

export interface StepTemplate {
  step_key: string;
  title: string;
  body: string;
  cta_label?: string;
  cta_url?: string;
  phone_to_call?: string;
  /** Hoist to position 1 when amount_lost > 0 within 24hr */
  time_sensitive?: boolean;
  category?: 'stop' | 'recall' | 'freeze' | 'report' | 'verify' | 'heal' | 'protect' | 'evidence';
}

// ---- Canonical contacts (verified 2026-04-18) ----

const FTC_REPORT_URL   = 'https://reportfraud.ftc.gov';
const FTC_IDTHEFT_URL  = 'https://www.identitytheft.gov';
const IC3_REPORT_URL   = 'https://www.ic3.gov/Home/FileComplaint';
const TIGTA_REPORT_URL = 'https://www.tigta.gov/reportcrime-misconduct';
const TIGTA_PHONE      = '+18003664484';
const SSA_OIG_URL      = 'https://oig.ssa.gov/report';
const SSA_HOTLINE      = '+18002690271';
const USPIS_REPORT_URL = 'https://www.uspis.gov/report';
const FCC_COMPLAINT_URL = 'https://consumercomplaints.fcc.gov/hc/en-us/requests/new';
const FCC_PHONE        = '+18882255322';
const CFPB_COMPLAINT_URL = 'https://www.consumerfinance.gov/complaint/';
const SEC_TCR_URL      = 'https://www.sec.gov/tcr';
const FINRA_TIP_URL    = 'https://www.finra.org/investors/have-problem/file-tip';
const CFTC_TIP_URL     = 'https://www.cftc.gov/complaint';
const FMCSA_URL        = 'https://www.fmcsa.dot.gov/protect-your-move';
const FMCSA_PHONE      = '+18883687238';
const NCMEC_CYBERTIP_URL = 'https://report.cybertip.org';
const NCMEC_PHONE      = '+18008435678';
const FEMA_FRAUD_URL   = 'https://www.fema.gov/about/offices/inspector-general/report-fraud';
const FEMA_PHONE       = '+18667205721';
const SMP_PHONE        = '+18778082468';
const MEDICARE_PHONE   = '+18006334227';
const VA_OIG_PHONE     = '+18004888244';
const VA_OIG_URL       = 'https://www.va.gov/oig/hotline';
const FEC_URL          = 'https://www.fec.gov/help-candidates-and-committees/dealing-possible-fraud';
const FTC_DNC_URL      = 'https://www.donotcall.gov';
const CENSUS_VERIFY_PHONE = '+18009238282';
const CENSUS_VERIFY_URL = 'https://www.census.gov/programs-surveys/are-you-in-a-survey.html';
const NCDF_URL         = 'https://www.justice.gov/criminal/criminal-fraud/national-center-disaster-fraud';
const FTC_DEBT_URL     = 'https://consumer.ftc.gov/articles/fake-and-abusive-debt-collectors';

const EQUIFAX_URL      = 'https://www.equifax.com/personal/credit-report-services/credit-freeze/';
const EQUIFAX_PHONE    = '+18003495191';
const EXPERIAN_URL     = 'https://www.experian.com/freeze/center.html';
const EXPERIAN_PHONE   = '+18883973742';
const TRANSUNION_URL   = 'https://www.transunion.com/credit-freeze';
const TRANSUNION_PHONE = '+18886805652';

const APPLE_GIFT_CARD_URL    = 'https://support.apple.com/en-us/120933';
// Apple's only phone line for fraud triage is the main AppleCare number
// (1-800-APL-CARE = 1-800-275-2273). Say "gift cards" when prompted.
const APPLE_GIFT_CARD_PHONE  = '+18002752273';
const GOOGLE_PLAY_FRAUD_URL  = 'https://support.google.com/googleplay/answer/7577221';
const AMAZON_GIFT_FRAUD_URL  = 'https://www.amazon.com/gp/help/customer/display.html?nodeId=GKQT3VWK4L7LQBTX';
const AMAZON_CUSTOMER_PHONE  = '+18882804331';

// Coinbase does not operate an inbound support phone line — every
// published "Coinbase support number" online is either outdated or
// a scammer's clone. Direct victims to the web support form only.
const COINBASE_FRAUD_URL   = 'https://help.coinbase.com/en/contact-us';
const BITCOIN_DEPOT_URL    = 'https://bitcoindepot.com/contact';

const APPLE_ID_URL   = 'https://iforgot.apple.com';
const GOOGLE_REC_URL = 'https://g.co/recover';

const STUDENT_AID_URL = 'https://studentaid.gov/manage-loans/forgiveness-cancellation';
const HEALTHCARE_GOV  = 'https://www.healthcare.gov';
const PET_SCAM_LOOKUP = 'https://www.petscams.com';
const FINCEN_TIMESHARE_URL = 'https://www.fincen.gov/news/news-releases/fincen-ofac-and-fbi-joint-notice-timeshare-fraud-associated-mexico-based';

const AARP_FRAUD_HOTLINE  = '+18779083360';
// 988 is the current US national Suicide & Crisis Lifeline (launched
// 2022). Dialable from any US phone. Victim-support step uses "988"
// directly as the phone_to_call value — iOS tel:988 routes correctly.
const NDVF_URL            = 'https://victimsofcrime.org';

const WIRE_RECALL_GUIDE = 'https://www.consumerfinance.gov/ask-cfpb/what-if-i-wired-money-and-didnt-get-it-en-1061/';
const IC3_FFKC_URL      = 'https://www.ic3.gov/Home/FinancialFraudKillChain';

// ============================================================================
//   Shared building blocks
// ============================================================================

const STOP_THE_CALL: StepTemplate = {
  step_key: 'disconnect',
  title: 'Stop the call and block the number',
  body: "If you're still on the line, hang up. Tap the number in Recents and choose \"Block Contact.\" AegisDial will keep flagging it — for you and for every other AegisDial user.",
  category: 'stop',
};

const WIRE_RECALL: StepTemplate = {
  step_key: 'wire_recall',
  title: 'Call your bank and request a wire recall — NOW',
  body: "If you sent a wire or Zelle in the last 24 hours, your bank can sometimes reverse it. Every minute matters. Call the fraud line on the BACK of your card. Use the exact phrase: \"I need to initiate a wire recall — I was scammed.\" Don't hang up until they confirm the request is filed.",
  cta_label: 'How wire recall works', cta_url: WIRE_RECALL_GUIDE,
  time_sensitive: true, category: 'recall',
};

const IC3_FFKC_RAT: StepTemplate = {
  step_key: 'ic3_ffkc',
  title: "File FBI IC3's Financial Fraud Kill Chain (FFKC)",
  body: "For wires $50k+ (domestic) or $50k+ (international), the FBI can freeze the receiving account if reported within ~72 hrs. Mention FFKC explicitly in your IC3 complaint. Attach the wire confirmation number.",
  cta_label: 'IC3 FFKC program', cta_url: IC3_FFKC_URL,
  time_sensitive: true, category: 'recall',
};

const FREEZE_EQUIFAX: StepTemplate = {
  step_key: 'freeze_equifax', title: 'Freeze your Equifax credit',
  body: 'Prevents anyone — including the scammer — from opening new credit in your name. Free, takes 60 seconds.',
  cta_label: 'Freeze at Equifax', cta_url: EQUIFAX_URL, phone_to_call: EQUIFAX_PHONE, category: 'freeze',
};
const FREEZE_EXPERIAN: StepTemplate = {
  step_key: 'freeze_experian', title: 'Freeze your Experian credit',
  body: 'Same 60-second freeze with Experian.',
  cta_label: 'Freeze at Experian', cta_url: EXPERIAN_URL, phone_to_call: EXPERIAN_PHONE, category: 'freeze',
};
const FREEZE_TRANSUNION: StepTemplate = {
  step_key: 'freeze_transunion', title: 'Freeze your TransUnion credit',
  body: 'Final bureau — often the one scammers exploit first.',
  cta_label: 'Freeze at TransUnion', cta_url: TRANSUNION_URL, phone_to_call: TRANSUNION_PHONE, category: 'freeze',
};

const CALL_BANK_FRAUD: StepTemplate = {
  step_key: 'call_bank_fraud', title: "Call your bank's fraud department",
  body: "Don't call the number they gave you. Find the fraud line on the BACK of your card, or in the bank's official app. Open AegisDial → Settings → Banks for the verified number. Tell them exactly what you told the scammer.",
  category: 'recall',
};
const FREEZE_CARDS: StepTemplate = {
  step_key: 'freeze_cards', title: 'Lock or replace the exposed card',
  body: "Open your banking app and tap \"Lock card.\" If you shared CVV/PIN, request a replacement — most banks issue within 3–5 days.",
  category: 'freeze',
};

const REG_E_DISPUTE: StepTemplate = {
  step_key: 'reg_e_dispute', title: 'File a written Reg E dispute with your bank',
  body: "Zelle/Venmo/Cash App transfers are usually not refunded, but filing a written Reg E dispute within 60 days locks in your rights and triggers the bank's 10-day investigation clock. Keep a copy of the letter.",
  category: 'recall',
};
const CFPB_COMPLAINT: StepTemplate = {
  step_key: 'cfpb_complaint', title: 'File a CFPB complaint',
  body: "The Consumer Financial Protection Bureau's complaint process gets a written response from the bank within 15 days. Use it when the bank refuses to refund a P2P scam.",
  cta_label: 'CFPB complaint form', cta_url: CFPB_COMPLAINT_URL, category: 'report',
};

const GIFT_CARD_FREEZE_APPLE: StepTemplate = {
  step_key: 'gift_card_freeze_apple', title: 'Call Apple to freeze the gift cards',
  body: "Apple has a dedicated gift-card fraud process. Report the 16-digit codes BEFORE the scammer redeems them — sometimes refundable.",
  cta_label: 'Apple gift card scams info', cta_url: APPLE_GIFT_CARD_URL, phone_to_call: APPLE_GIFT_CARD_PHONE,
  time_sensitive: true, category: 'recall',
};
const GIFT_CARD_FREEZE_GOOGLE: StepTemplate = {
  step_key: 'gift_card_freeze_google', title: 'Report Google Play gift cards',
  body: 'Google Play fraud form — include the scratch-off codes.',
  cta_label: 'Google Play fraud form', cta_url: GOOGLE_PLAY_FRAUD_URL,
  time_sensitive: true, category: 'recall',
};
const GIFT_CARD_FREEZE_AMAZON: StepTemplate = {
  step_key: 'gift_card_freeze_amazon', title: 'Call Amazon gift card support',
  body: 'Amazon freezes unused balances if reported fast. Keep the claim-check number.',
  cta_label: 'Amazon gift card fraud', cta_url: AMAZON_GIFT_FRAUD_URL, phone_to_call: AMAZON_CUSTOMER_PHONE,
  time_sensitive: true, category: 'recall',
};
const GIFT_CARD_FREEZE_OTHER: StepTemplate = {
  step_key: 'gift_card_freeze_other', title: 'Call the issuing retailer (Target / Walmart)',
  body: "Target GiftCard Services: +1-800-544-2943. Walmart GiftCard Services: +1-888-537-5503. Ask to freeze the cards if the codes haven't been redeemed yet.",
  time_sensitive: true, category: 'recall',
};

const BITCOIN_KIOSK_CALL: StepTemplate = {
  step_key: 'bitcoin_kiosk_call', title: 'Call the Bitcoin ATM operator',
  body: "Bitcoin Depot, CoinHub, CoinFlip, and most other kiosk operators have fraud-reversal teams — reachable via the 800 number on the receipt or their contact page. File within 24 hrs for any chance of recovery.",
  cta_label: 'Bitcoin Depot contact', cta_url: BITCOIN_DEPOT_URL,
  time_sensitive: true, category: 'recall',
};

const CRYPTO_FREEZE_EXCHANGE: StepTemplate = {
  step_key: 'crypto_freeze_exchange', title: "Contact your exchange's fraud desk",
  body: "Coinbase / Robinhood / Kraken / Binance.US can sometimes flag the destination wallet and freeze it if contacted before the scammer cashes out. Minutes matter. Use the web support form — Coinbase and most exchanges do NOT accept inbound phone calls (any phone number claiming to be them is itself a scam).",
  cta_label: 'Coinbase support', cta_url: COINBASE_FRAUD_URL,
  time_sensitive: true, category: 'recall',
};
const CRYPTO_TRACE_WALLET: StepTemplate = {
  step_key: 'crypto_trace_wallet', title: 'Save the destination wallet address',
  body: "Copy the receiving wallet from your transaction history. Law enforcement and exchanges use this to trace funds.",
  category: 'evidence',
};

const CARRIER_PORT_FREEZE: StepTemplate = {
  step_key: 'carrier_port_freeze', title: 'Call your carrier — freeze the port + SIM swap',
  body: "AT&T, Verizon, T-Mobile all have port-out / SIM-swap lockdown options. Say: \"I need to enable port freeze and SIM swap protection on my line right now — this is a fraud emergency.\" Use *611 or the number in your phone's About screen (NOT from an email).",
  time_sensitive: true, category: 'recall',
};

const REMOVE_REMOTE_ACCESS: StepTemplate = {
  step_key: 'remove_remote_access', title: 'Remove remote-access software',
  body: "Uninstall AnyDesk / TeamViewer / LogMeIn / Supremo / Splashtop. Change Apple ID, Google, banking, and email passwords FROM A DIFFERENT DEVICE.",
  category: 'protect',
};
const SCAN_MALWARE: StepTemplate = {
  step_key: 'scan_for_malware', title: 'Run a malware scan',
  body: "macOS: XProtect runs automatically. Windows: Windows Security → Full scan. iOS/Android: OS sandbox blocks most installed malware.",
  category: 'protect',
};
const ROTATE_PASSWORDS: StepTemplate = {
  step_key: 'rotate_passwords', title: 'Rotate your important passwords',
  body: "Email first (master key), then banking, then any shared password. Use a password manager. Turn on 2-factor authentication everywhere.",
  category: 'protect',
};
const RECOVER_APPLE_ID: StepTemplate = {
  step_key: 'recover_apple_id', title: 'Recover your Apple ID',
  body: "Reset from a trusted device.",
  cta_label: 'iforgot.apple.com', cta_url: APPLE_ID_URL, category: 'protect',
};
const RECOVER_GOOGLE: StepTemplate = {
  step_key: 'recover_google', title: 'Recover your Google account',
  body: "Use g.co/recover from a trusted device.",
  cta_label: 'g.co/recover', cta_url: GOOGLE_REC_URL, category: 'protect',
};

const FTC_REPORT: StepTemplate = {
  step_key: 'ftc_report', title: 'File a federal FTC complaint',
  body: "Open the FTC form at reportfraud.ftc.gov. Bring the scammer's number, the time of the call, and the amount (if any). The FTC feeds these reports to law enforcement nationwide.",
  cta_label: 'Open FTC report', cta_url: FTC_REPORT_URL, category: 'report',
};
const IDENTITY_THEFT_GOV: StepTemplate = {
  step_key: 'identity_theft_gov', title: 'File an identity-theft affidavit',
  body: "IdentityTheft.gov generates Form 14039 (IRS identity-theft affidavit) and a personalized recovery plan. This is the document creditors will ask for.",
  cta_label: 'Open IdentityTheft.gov', cta_url: FTC_IDTHEFT_URL, category: 'report',
};
const IRS_IP_PIN: StepTemplate = {
  step_key: 'irs_ip_pin', title: 'Request an IRS Identity Protection PIN',
  body: "An IP PIN is a 6-digit number the IRS requires on your next return. Prevents scammers from filing a fake return in your name.",
  cta_label: 'Request IP PIN', cta_url: 'https://www.irs.gov/identity-theft-fraud-scams/get-an-identity-protection-pin',
  category: 'protect',
};
const IC3_REPORT: StepTemplate = {
  step_key: 'ic3_report', title: 'File an FBI IC3 complaint',
  body: "For wires, crypto, or amounts over $1,000, IC3 is the right place. Many successful recoveries start here.",
  cta_label: 'Open FBI IC3', cta_url: IC3_REPORT_URL, category: 'report',
};
const POLICE_REPORT: StepTemplate = {
  step_key: 'police_report', title: 'File a local police report',
  body: "Most insurance claims and some bank reversals require a police report number. Call the non-emergency line.",
  category: 'report',
};
const TIGTA_REPORT: StepTemplate = {
  step_key: 'tigta_report', title: 'Report the IRS impersonation to TIGTA',
  body: "The real IRS never demands payment by phone or gift card. TIGTA (Treasury's IRS oversight) actively investigates these rings.",
  cta_label: 'File with TIGTA', cta_url: TIGTA_REPORT_URL, phone_to_call: TIGTA_PHONE, category: 'report',
};
const SSA_OIG_REPORT: StepTemplate = {
  step_key: 'ssa_oig_report', title: "Report the Social Security impersonation",
  body: "The real SSA never suspends your number. Report to the SSA Office of the Inspector General.",
  cta_label: 'SSA OIG report', cta_url: SSA_OIG_URL, phone_to_call: SSA_HOTLINE, category: 'report',
};
const USPIS_REPORT: StepTemplate = {
  step_key: 'uspis_report', title: 'Report the USPS / package scam',
  body: "Package redelivery scams go to the US Postal Inspection Service. UPS and FedEx scams cross-file here too.",
  cta_label: 'File with USPIS', cta_url: USPIS_REPORT_URL, category: 'report',
};
const FCC_COMPLAINT: StepTemplate = {
  step_key: 'fcc_complaint', title: 'Report to the FCC',
  body: "For robocalls, auto-warranty scams, and suspected carrier fraud. Reduces calls for you and other users.",
  cta_label: 'FCC complaint', cta_url: FCC_COMPLAINT_URL, phone_to_call: FCC_PHONE, category: 'report',
};
const FTC_DNC: StepTemplate = {
  step_key: 'ftc_dnc', title: 'Register with Do Not Call',
  body: "Adding your number to the National Do Not Call Registry helps enforcement build cases against violators.",
  cta_label: 'donotcall.gov', cta_url: FTC_DNC_URL, category: 'protect',
};
const STATE_AG_REPORT: StepTemplate = {
  step_key: 'state_ag_report', title: "File with your state Attorney General",
  body: "State AGs investigate consumer fraud in their state. Find your AG at naag.org/find-my-ag.",
  cta_label: 'Find my state AG', cta_url: 'https://www.naag.org/find-my-ag/', category: 'report',
};

const FAMILY_NOTIFY: StepTemplate = {
  step_key: 'notify_family', title: 'Let your family know',
  body: "Scammers re-target the same family. Tap below to send an AegisDial-branded alert to every guardian on your plan.",
  cta_label: 'Send family alert', category: 'protect',
};

const AARP_HOTLINE: StepTemplate = {
  step_key: 'aarp_hotline', title: "You're not alone — talk to someone",
  body: "AARP Fraud Watch Helpline — free, confidential, trained counselors. Any age, not just AARP members.",
  phone_to_call: AARP_FRAUD_HOTLINE, category: 'heal',
};
const VICTIM_SUPPORT: StepTemplate = {
  step_key: 'victim_support', title: 'Crisis support if you need it',
  body: "988 is the free, 24/7 national Suicide & Crisis Lifeline — routes to a trained counselor. Losing money to a scam is traumatic. You are not stupid; you were targeted by professionals.",
  // iOS dials this as 988 via tel:988 — the canonical 3-digit shortcode.
  phone_to_call: '988',
  cta_label: 'National Center for Victims of Crime', cta_url: NDVF_URL,
  category: 'heal',
};

const CAPTURE_EVIDENCE: StepTemplate = {
  step_key: 'capture_evidence', title: 'Save everything — before you forget',
  body: "Screenshot the texts, note the exact amount lost, account numbers or wallet addresses, timeline. Banks, police, and insurance all ask for this later. Tap to open your evidence locker — stored to your account, encrypted in transit.",
  cta_label: 'Open evidence locker', category: 'evidence',
};

const RECOVERY_SCAM_WARNING: StepTemplate = {
  step_key: 'recovery_scam_warning',
  title: "⚠︎ Watch out for recovery scams",
  body: "Within days, someone may call claiming to be the \"FBI asset recovery division,\" a lawyer, or a crypto-recovery firm who can get your money back — for a fee. This is a second scam targeting victim lists. Never pay upfront. Only IC3 and your own bank can actually help, and they don't charge.",
  category: 'protect',
};

// Appended whenever the user reports money lost (opts.amountLost). Many
// major carriers bundle identity-restoration coverage with homeowners /
// renters / auto — victims routinely miss this benefit.
const HOMEOWNERS_INSURANCE_CHECK: StepTemplate = {
  step_key: 'homeowners_insurance_check',
  title: 'Check your homeowners/renters policy for identity-fraud coverage',
  body: "Many Liberty Mutual, State Farm, Allstate, Nationwide, and USAA policies include $15k–$50k of identity-restoration or fraud-expense coverage. Look for 'identity restoration,' 'fraud expense,' or 'cyber protection' riders. Call the number on your policy (NOT a number the scammer gave you) and ask what's covered.",
  category: 'heal',
};

// ============================================================================
//   Type-specific overlays
// ============================================================================

const ROMANCE_SPECIFIC: StepTemplate[] = [
  { step_key: 'romance_stop_contact', title: 'Stop all contact', body: "Block the number, block the app. They'll pivot to sympathy, blackmail, threats. None of it is real.", category: 'stop' },
  { step_key: 'romance_reverse_image', title: 'Reverse-image search the photos', body: "Upload the profile photo to images.google.com — romance scammers recycle stolen photos of real people.", cta_label: 'Google reverse image', cta_url: 'https://images.google.com', category: 'evidence' },
];
const INVESTMENT_SPECIFIC: StepTemplate[] = [
  { step_key: 'investment_sec_report', title: 'Report to the SEC', body: "SEC.gov/tcr is the federal complaint form for investment fraud.", cta_label: 'SEC complaint', cta_url: SEC_TCR_URL, category: 'report' },
  { step_key: 'investment_finra_report', title: 'Report to FINRA', body: "FINRA investigates broker-dealer fraud.", cta_label: 'FINRA tip', cta_url: FINRA_TIP_URL, category: 'report' },
  { step_key: 'investment_cftc_report', title: 'Report crypto/commodities to CFTC', body: "The CFTC handles crypto trading platform fraud.", cta_label: 'CFTC tip form', cta_url: CFTC_TIP_URL, category: 'report' },
];
const GRANDCHILD_SPECIFIC: StepTemplate[] = [
  { step_key: 'grandchild_verify', title: 'Call the real grandchild now', body: "Use the number YOU have saved — never a number the caller gave you. Most \"grandchild arrested\" calls are voice-clone scams.", time_sensitive: true, category: 'verify' },
  { step_key: 'setup_safe_word', title: 'Set up a family safe word', body: "In Family Contacts, save a safe word with each grandchild. A voice clone doesn't know what you agreed on over Thanksgiving dinner.", cta_label: 'Open Family Contacts', category: 'protect' },
];
const VIRTUAL_KIDNAP_SPECIFIC: StepTemplate[] = [
  { step_key: 'virtual_kidnap_call_911', title: 'Call 911 — from another phone', body: "If someone claims to have your child/spouse: use a DIFFERENT phone to call 911 and the claimed victim simultaneously. Virtual-kidnap ransom scams rely on you never verifying.", time_sensitive: true, category: 'verify' },
  { step_key: 'virtual_kidnap_callback', title: 'Try to reach the claimed victim on every channel', body: "Text, iMessage, FaceTime, social DMs. Ask someone nearby. The kidnap pretext is fake 99%+ of the time.", time_sensitive: true, category: 'verify' },
];
const AI_VOICE_SPECIFIC: StepTemplate[] = [
  { step_key: 'ai_voice_callback_saved', title: 'Hang up. Call them back on their saved number.', body: "AI voice-clone scams use 3 seconds of public audio. The voice will sound real. A callback to the number YOU saved is the definitive test.", time_sensitive: true, category: 'verify' },
  { step_key: 'ai_voice_safe_word', title: 'Ask for your safe word', body: "If you've registered a family safe word in AegisDial, ask for it. A voice clone won't know.", cta_label: 'Open Family Contacts', category: 'verify' },
];
const SEXTORTION_SPECIFIC: StepTemplate[] = [
  { step_key: 'sextortion_do_not_pay', title: 'Do NOT pay. Paying does not make them stop.', body: "Sextortion scammers release the content either way — payment just confirms you're a target. Block the sender and save the messages.", category: 'stop' },
  { step_key: 'sextortion_ncmec', title: 'If a minor is involved — NCMEC CyberTipline', body: "If YOU are under 18 or anyone under 18 is involved, file with NCMEC's CyberTipline immediately. They coordinate with platforms to remove content and the FBI.", cta_label: 'NCMEC CyberTipline', cta_url: NCMEC_CYBERTIP_URL, phone_to_call: NCMEC_PHONE, time_sensitive: true, category: 'report' },
  { step_key: 'sextortion_ic3', title: 'File with FBI IC3', body: "Adult sextortion goes to IC3. Include the crypto wallet / payment channel they asked for.", cta_label: 'FBI IC3', cta_url: IC3_REPORT_URL, category: 'report' },
];
const PIG_BUTCHER_SPECIFIC: StepTemplate[] = [
  { step_key: 'pig_recognize', title: "You were pig-butchered — this is a multi-billion-dollar category", body: "Pig-butchering (sha zhu pan) builds a relationship, moves you to a fake trading platform, shows fake gains, then 'locks' withdrawal behind 'taxes' or 'fees.' None of the money was ever yours. FBI Operation Level-Up has recovered funds for some victims.", category: 'verify' },
  { step_key: 'pig_operation_level_up', title: 'Contact FBI Operation Level-Up', body: "FBI Operation Level-Up identifies and notifies pig-butchering victims. Include every screenshot, wallet address, and transaction.", cta_label: 'FBI IC3 (mention Operation Level-Up)', cta_url: IC3_REPORT_URL, time_sensitive: true, category: 'recall' },
];
const CAR_WARRANTY_SPECIFIC: StepTemplate[] = [
  { step_key: 'warranty_dispute_charge', title: 'Dispute the charge with your card issuer', body: "If you paid, file a chargeback — auto-warranty scams are routinely reversed because the warranty is either non-existent or priced at 10× actual cost.", category: 'recall' },
  { step_key: 'warranty_fcc_complaint', title: 'Report the robocall to the FCC', body: "Auto-warranty robocalls are the #1 complaint category — your report helps the FCC build enforcement cases.", cta_label: 'FCC complaint', cta_url: FCC_COMPLAINT_URL, category: 'report' },
];
const DEBT_PHANTOM_SPECIFIC: StepTemplate[] = [
  { step_key: 'phantom_debt_verify', title: 'Demand a debt validation letter', body: "Under the FDCPA, any debt collector must send a written validation letter within 5 days. Scammers can't. Demand one in writing — they'll usually disappear.", cta_label: 'FDCPA your rights', cta_url: FTC_DEBT_URL, category: 'verify' },
  { step_key: 'phantom_debt_cfpb', title: 'File a CFPB complaint', body: "CFPB has shut down multiple phantom-debt rings after consumer complaints.", cta_label: 'CFPB complaint', cta_url: CFPB_COMPLAINT_URL, category: 'report' },
];
const EMPLOYMENT_SPECIFIC: StepTemplate[] = [
  { step_key: 'employment_fake_check', title: 'Return any check they sent — do not deposit', body: "Fake-check employment scams rely on a 3-day float: you deposit, they ask you to pay 'training fees' from your real money, the check bounces days later and you're on the hook.", category: 'recall' },
  { step_key: 'employment_bbb_report', title: 'Report to BBB Scam Tracker', body: "BBB Scam Tracker warns other job seekers about the specific fake employer.", cta_label: 'BBB Scam Tracker', cta_url: 'https://www.bbb.org/scamtracker', category: 'report' },
];
const CHARITY_SPECIFIC: StepTemplate[] = [
  { step_key: 'charity_verify', title: "Verify the charity's legitimacy", body: "charitynavigator.org or give.org. If it doesn't exist there and wasn't started after a recent disaster, it's fake.", cta_label: 'Charity Navigator', cta_url: 'https://www.charitynavigator.org', category: 'verify' },
  { step_key: 'charity_state_ag', title: "Report to your state AG's charity registrar", body: "Most states require charities to register; AGs investigate unregistered fraud.", category: 'report' },
];
const RENTAL_SPECIFIC: StepTemplate[] = [
  { step_key: 'rental_screenshot_listing', title: 'Save the listing and conversation', body: "Screenshot the listing, chat history, and photos. Reverse-image-search the photos — rental scams use stolen photos.", category: 'evidence' },
  { step_key: 'rental_platform_report', title: 'Report to the platform', body: "Zillow / Craigslist / FB Marketplace can remove the fraudulent listing.", category: 'report' },
];
const UTILITY_SPECIFIC: StepTemplate[] = [
  { step_key: 'utility_verify', title: "Call your utility's official number", body: "Get the number from your paper bill or statement. Real utilities don't threaten immediate disconnection or demand gift-card/wire/crypto payment.", category: 'verify' },
  { step_key: 'utility_ag_report', title: 'File with your state AG', body: "State AGs actively prosecute utility impersonation.", category: 'report' },
];
const TIMESHARE_SPECIFIC: StepTemplate[] = [
  { step_key: 'timeshare_fincen_sar', title: 'Ask your bank to file a SAR', body: "FinCEN/OFAC/FBI issued a 2024 joint notice on Mexico-based timeshare fraud linked to cartels. If you sent money, ask your bank to file a Suspicious Activity Report referencing the notice.", cta_label: 'FinCEN timeshare notice', cta_url: FINCEN_TIMESHARE_URL, time_sensitive: true, category: 'report' },
  { step_key: 'timeshare_fbi_ic3', title: 'File FBI IC3 complaint', body: "Include the Mexico-based context — helps FBI investigators connect cases.", cta_label: 'FBI IC3', cta_url: IC3_REPORT_URL, category: 'report' },
];
const SOLAR_SPECIFIC: StepTemplate[] = [
  { step_key: 'solar_rescission', title: "Cancel within the 3-day rescission window", body: "Federal law gives you 3 business days to cancel in writing a door-to-door or high-pressure sale. Send by certified mail — keep the receipt.", time_sensitive: true, category: 'recall' },
  { step_key: 'solar_check_lien', title: 'Check for a lien on your home', body: "Some 'free solar' schemes record a UCC lien without the homeowner realizing. Check your county recorder's office. If found, file a lien dispute.", category: 'verify' },
];
const PET_SPECIFIC: StepTemplate[] = [
  { step_key: 'pet_lookup_registry', title: "Check PetScams.com", body: "Known scam breeder listings are catalogued at petscams.com — search the seller's email, phone, or business name.", cta_label: 'PetScams.com', cta_url: PET_SCAM_LOOKUP, category: 'verify' },
  { step_key: 'pet_platform_report', title: 'Report the listing', body: "Report to the platform (Craigslist, FB Marketplace) and BBB Scam Tracker.", category: 'report' },
];
const MOVING_SPECIFIC: StepTemplate[] = [
  { step_key: 'moving_fmcsa_report', title: "File with FMCSA's NCCDB", body: "Federal Motor Carrier Safety Administration handles moving-company extortion ('hostage goods'). Call 888-368-7238 or file online.",
    cta_label: 'FMCSA Protect Your Move', cta_url: FMCSA_URL, phone_to_call: FMCSA_PHONE, category: 'report' },
];
const FUNERAL_SPECIFIC: StepTemplate[] = [
  { step_key: 'funeral_call_real', title: 'Call the real funeral home', body: "Look up the number yourself — don't use one the caller gave you. Scammers use obituary data to pretext grieving families.", category: 'verify' },
  { step_key: 'funeral_state_board', title: 'Report to your state funeral services board', body: "Each state has a funeral regulatory board that investigates impersonation.", category: 'report' },
];
const HOME_REPAIR_SPECIFIC: StepTemplate[] = [
  { step_key: 'home_repair_licensing', title: "Check the contractor's license", body: "Most states require a license for roofing / major repair. Look them up via your state's contractor licensing board.", category: 'verify' },
  { step_key: 'home_repair_insurance', title: 'Alert your insurance carrier', body: "Storm-chaser contractors often inflate claims and vanish with the deductible. Your insurer's SIU (Special Investigations Unit) wants to know.", category: 'report' },
];
const STUDENT_LOAN_SPECIFIC: StepTemplate[] = [
  { step_key: 'student_loan_fsa_reset', title: "Reset your FSA ID password", body: "If you gave credentials to a 'forgiveness processor,' they now have StudentAid.gov access. Reset immediately at studentaid.gov.", cta_label: 'StudentAid.gov', cta_url: STUDENT_AID_URL, category: 'protect' },
  { step_key: 'student_loan_cfpb', title: 'File a CFPB complaint', body: "CFPB supervises student loan servicers and investigates fake-forgiveness processors.", cta_label: 'CFPB complaint', cta_url: CFPB_COMPLAINT_URL, category: 'report' },
];
const VETERANS_SPECIFIC: StepTemplate[] = [
  { step_key: 'veterans_oig', title: "Report to VA Office of Inspector General", body: "VA OIG (800-488-8244) investigates buyout scams and benefits fraud. They actively prosecute pension-poaching rings.",
    cta_label: 'VA OIG hotline', cta_url: VA_OIG_URL, phone_to_call: VA_OIG_PHONE, category: 'report' },
  { step_key: 'veterans_state_affairs', title: 'Contact your state Veterans Affairs office', body: "State-level VA offices have benefits counselors who review any contract before you sign.", category: 'verify' },
];
const MEDICARE_SPECIFIC: StepTemplate[] = [
  { step_key: 'medicare_smp', title: 'Call Senior Medicare Patrol (SMP)', body: "SMP has trained volunteers in every state who handle Medicare fraud reports and help victims.",
    phone_to_call: SMP_PHONE, category: 'report' },
  { step_key: 'medicare_new_card', title: 'Request a new Medicare card', body: "If you gave out your Medicare number, call 1-800-MEDICARE and ask for a new card to prevent claim fraud.",
    phone_to_call: MEDICARE_PHONE, category: 'protect' },
];
const POLITICAL_SPECIFIC: StepTemplate[] = [
  { step_key: 'political_fec_report', title: 'File with the FEC', body: "Scam PACs (fake Trump/Biden/cause committees) fall under Federal Election Commission jurisdiction.",
    cta_label: 'FEC fraud reporting', cta_url: FEC_URL, category: 'report' },
];
const CENSUS_SPECIFIC: StepTemplate[] = [
  { step_key: 'census_verify', title: 'Verify the caller was really Census', body: "The real Census Bureau's regional offices can confirm if you were part of a survey. They NEVER ask for SSN or full banking info.",
    cta_label: "Am I in a survey?", cta_url: CENSUS_VERIFY_URL, phone_to_call: CENSUS_VERIFY_PHONE, category: 'verify' },
];
const FEMA_SPECIFIC: StepTemplate[] = [
  { step_key: 'fema_hotline', title: 'Call FEMA Disaster Fraud Hotline', body: "866-720-5721 is the dedicated disaster-fraud line — connects to DOJ's National Center for Disaster Fraud.",
    phone_to_call: FEMA_PHONE, cta_url: NCDF_URL, cta_label: 'DOJ Disaster Fraud', category: 'report' },
  { step_key: 'fema_oig', title: 'Report to FEMA OIG', body: "FEMA Office of Inspector General also takes reports of impersonators soliciting disaster assistance fees.",
    cta_label: 'FEMA OIG', cta_url: FEMA_FRAUD_URL, category: 'report' },
];
const ACA_SPECIFIC: StepTemplate[] = [
  { step_key: 'aca_healthcare_gov', title: 'Enroll directly at HealthCare.gov', body: "Never use a 'navigator' who called you. Go directly to healthcare.gov — enrollment is free.",
    cta_label: 'HealthCare.gov', cta_url: HEALTHCARE_GOV, category: 'verify' },
];
const TAX_PREP_SPECIFIC: StepTemplate[] = [
  { step_key: 'tax_prep_form_14039', title: 'File IRS Form 14039', body: "If someone filed a return in your name using info from a fake preparer, Form 14039 is the official identity-theft record.",
    cta_label: 'Form 14039', cta_url: 'https://www.irs.gov/forms-pubs/about-form-14039', category: 'report' },
];
const RECOVERY_SCAM_SPECIFIC: StepTemplate[] = [
  { step_key: 'recovery_scam_explain', title: "This was a SECOND scam targeting scam victims", body: "You're on a recycled victim list that's been sold many times. Fake 'recovery specialists,' fake FBI agents, fake lawyers will keep calling. Never pay anyone who promises to recover your money.", category: 'verify' },
  { step_key: 'recovery_scam_ic3', title: 'Report the recovery scammer', body: "Send everything to IC3 so they can add the new number/wallet to their watchlists.",
    cta_label: 'FBI IC3', cta_url: IC3_REPORT_URL, category: 'report' },
];
const SUBSCRIPTION_SPECIFIC: StepTemplate[] = [
  { step_key: 'subscription_chargeback', title: 'Dispute the charge as unauthorized', body: "Under the FTC's Click-to-Cancel rule, recurring charges without explicit consent or easy cancellation are unlawful. Your card issuer will refund.", category: 'recall' },
  { step_key: 'subscription_ftc', title: 'File with FTC', body: "FTC tracks subscription traps and has brought multi-million-dollar cases.", cta_label: 'FTC report', cta_url: FTC_REPORT_URL, category: 'report' },
];
// Used to add CAPTURE_EVIDENCE to subscription flow too — keep the
// catalog symmetric so every flow ends with evidence + follow-ups.
const LOTTERY_SPECIFIC: StepTemplate[] = [
  { step_key: 'lottery_never_pay', title: "You can't win a lottery you didn't enter", body: "Any 'fees' or 'taxes' to claim a prize are the scam. Real lotteries deduct taxes from winnings; they never ask for money upfront.", category: 'stop' },
];
const INHERITANCE_SPECIFIC: StepTemplate[] = [
  { step_key: 'inheritance_never_pay', title: "No real executor charges fees to release funds", body: "Inheritance release, barrister fees, and 'unclaimed funds' requiring upfront payment are 100% scams.", category: 'stop' },
];
const DIGITAL_ARREST_SPECIFIC: StepTemplate[] = [
  { step_key: 'digital_arrest_hang_up', title: 'Hang up — you were never under arrest', body: "'Digital arrest' scams use video calls and uniforms to coerce payment. No US agency conducts arrests via Zoom.", category: 'stop' },
  { step_key: 'digital_arrest_consulate', title: 'If you are not a US citizen, call your consulate', body: "Many digital-arrest scams target Chinese, Indian, and other diaspora communities. Your consulate can verify any real immigration matter.", category: 'verify' },
];
const ICE_SPECIFIC: StepTemplate[] = [
  { step_key: 'ice_verify', title: "ICE doesn't take bond payments by phone", body: "In the normal process, ICE doesn't take bond payments over the phone. Immigration bonds are paid at a DHS office in person, or through an authorized bond agent listed on ice.gov. If you're unsure, call your consulate or an immigration attorney before sending money.", category: 'verify' },
  { step_key: 'ice_hsi_report', title: 'Report to ICE HSI', body: "Homeland Security Investigations tip line takes fraud reports.",
    cta_label: 'ICE HSI tip line', cta_url: 'https://www.ice.gov/webform/hsi-tip-form',
    phone_to_call: '+18663472423', category: 'report' },
];
const FBI_DEA_SPECIFIC: StepTemplate[] = [
  { step_key: 'fbi_dea_verify', title: "Real FBI/DEA don't call demanding payment", body: "Federal agents show up in person, with identification. They never call demanding payment to 'avoid arrest.' Call your local FBI field office (fbi.gov/contact-us) to verify.", category: 'verify' },
];
const QUISHING_SPECIFIC: StepTemplate[] = [
  { step_key: 'quishing_change_password', title: 'Change any password you entered', body: "QR codes lead to phishing sites designed to harvest credentials. Assume anything you typed is now in a scammer's database.", category: 'protect' },
  { step_key: 'quishing_card_dispute', title: 'Dispute any card charge + replace card', body: "If you entered card info, freeze the card and request a new one.", category: 'freeze' },
];
const FAKE_REFUND_SPECIFIC: StepTemplate[] = [
  { step_key: 'fake_refund_bank_alert', title: "Alert your bank — the 'refund' may reverse", body: "Geek Squad / Norton / McAfee refund scams sometimes 'accidentally refund' too much, then ask you to return the excess via gift card or wire. The 'refund' itself is a fake credit that reverses, leaving you out the gift cards.", time_sensitive: true, category: 'recall' },
  { step_key: 'fake_refund_chargeback', title: 'Chargeback any actual charges', body: "Card issuer will reverse any charges from the fake-refund company.", category: 'recall' },
];
const BANKING_PUSH_BOMBING_SPECIFIC: StepTemplate[] = [
  { step_key: 'push_bomb_deny_all', title: 'Deny every MFA prompt — then change password', body: "Attackers flood you with 2FA requests hoping you'll tap approve by accident. Deny all, then reset your banking password from a different device.", time_sensitive: true, category: 'protect' },
  { step_key: 'push_bomb_bank_alert', title: 'Call your bank and flag a credential-stuffing attempt', body: "Ask them to lock your account and require re-auth on next login.", category: 'recall' },
];
const ZELLE_VENMO_SPECIFIC: StepTemplate[] = [
  { step_key: 'zelle_venmo_bank_now', title: 'Call your bank within MINUTES — Zelle is usually final', body: "Zelle/Venmo/Cash App transfers are often irreversible once sent. Call your bank's fraud line immediately. Some banks reverse if reported within the hour.", time_sensitive: true, category: 'recall' },
  { step_key: 'zelle_venmo_platform', title: 'Report to Venmo/Cash App/Zelle directly', body: "Inside the app: Report a problem → Payment scam. Platforms can sometimes freeze the recipient's account.", category: 'report' },
];
const BITCOIN_ATM_SPECIFIC: StepTemplate[] = [
  { step_key: 'bitcoin_atm_receipt', title: 'Keep the kiosk receipt and wallet address', body: "Bitcoin ATMs print a receipt with the transaction hash and destination wallet — invaluable for recovery.", category: 'evidence' },
];

// Distinct from bank_impersonation: the scammer claims to be YOUR bank's
// fraud team and leads with "confirming" real account details to earn
// trust. Lead step spells out the one rule that breaks the scam — no real
// bank ever asks you to move money to a "safe account."
const BANK_EMPLOYEE_SPECIFIC: StepTemplate[] = [
  { step_key: 'bank_employee_callback_card_back', title: 'Hang up and call the number on the BACK of your card', body: "Caller ID can be spoofed to show your bank's real main line. The only number that's safe is the one printed on the back of the card or stored inside your bank's official app. Dial that number yourself — don't let the caller \"transfer\" you.", time_sensitive: true, category: 'verify' },
  { step_key: 'bank_employee_safe_account_rule', title: "Your bank will NEVER ask you to move money to a 'safe account'", body: "This is the single clearest tell. Any request — from anyone on any phone number — to transfer, wire, Zelle, or withdraw funds to \"protect\" them IS the scam. Real bank fraud teams freeze the account on their side; they never ask you to move the money.", category: 'verify' },
  { step_key: 'bank_employee_check_fraud_alerts', title: "Open your bank's real app and check fraud alerts", body: "Legitimate fraud alerts appear in your bank's app message center. If you see no alert there, there was no fraud case — the caller invented one.", category: 'verify' },
  { step_key: 'bank_employee_rotate_online_banking', title: 'Change your online-banking password', body: "Do this from a different device if possible. Enable 2-factor authentication on the account and update your security questions if the caller asked you to \"confirm\" them.", category: 'protect' },
];

// ClickFix / "Fix your browser" / fake CAPTCHA lure — a fast-growing 2025
// category tracked by Proofpoint and Microsoft. The attacker tricks the
// user into pasting a PowerShell or Terminal command. Lead action is to
// disconnect before any further commands execute.
const CLICKFIX_SPECIFIC: StepTemplate[] = [
  { step_key: 'clickfix_disconnect', title: 'Disconnect from the internet now', body: "Turn on Airplane Mode or unplug the ethernet cable. If a pasted command is still running or has planted a loader, cutting the network stops it from reaching its command-and-control server.", time_sensitive: true, category: 'stop' },
  { step_key: 'clickfix_no_more_commands', title: 'Do NOT run anything else in Terminal or PowerShell', body: "The \"Fix your browser\" and fake CAPTCHA lures tell you to paste a second or third command to \"complete verification.\" Close the Terminal / PowerShell window without typing anything more.", category: 'stop' },
  { step_key: 'clickfix_rotate_from_other_device', title: 'Rotate passwords from a DIFFERENT device', body: "Use your phone, a partner's laptop, or a tablet — not the machine where you pasted the command. Start with email, then banking, then any saved browser password.", category: 'protect' },
  { step_key: 'clickfix_scan_malware', title: 'Run a full malware scan', body: "macOS: XProtect runs automatically — also run the built-in MRT via Software Update. Windows: open Windows Security and choose Full scan, then Microsoft Defender Offline scan.", category: 'protect' },
  { step_key: 'clickfix_factory_reset', title: 'If you pasted any command, plan a factory reset', body: "ClickFix payloads commonly install info-stealers (Lumma, Vidar) that persist through reboots. Back up documents to external storage, then reinstall the OS from Apple/Microsoft recovery media. Treat any saved browser password as already compromised.", category: 'protect' },
];

// "Your retirement is in danger" calls targeting Fidelity/Vanguard/Schwab
// customers, primarily 55+. Specific step notes the 60-day brokerage
// dispute window so users don't miss it.
const BROKERAGE_401K_SPECIFIC: StepTemplate[] = [
  { step_key: 'brokerage_call_official', title: 'Call Fidelity / Vanguard / Schwab directly — from the statement', body: "Use the fraud number on the back of your quarterly statement or inside the official app. Never the number the caller gave you. Tell them you suspect an attempted account takeover.", time_sensitive: true, category: 'verify' },
  { step_key: 'brokerage_rotate_password', title: 'Rotate your brokerage password and enable MFA', body: "From a different device if possible. Turn on app-based or hardware-key multi-factor — SMS 2FA is not enough for retirement accounts.", category: 'protect' },
  { step_key: 'brokerage_review_7_days', title: 'Check for unauthorized trades in the last 7 days', body: "Review every trade, transfer, and withdrawal in the past week. Brokerages generally give you a 60-day window to dispute — flag anything unfamiliar in writing today so the clock starts on record.", category: 'verify' },
  { step_key: 'brokerage_sec_tcr', title: 'File a SEC TCR complaint', body: "SEC.gov/tcr is the federal complaint form for investment fraud and account-takeover attempts.", cta_label: 'SEC complaint', cta_url: SEC_TCR_URL, category: 'report' },
  { step_key: 'brokerage_finra_tip', title: 'File a FINRA tip', body: "FINRA investigates broker-dealer fraud and phishing rings targeting retirement accounts.", cta_label: 'FINRA tip', cta_url: FINRA_TIP_URL, category: 'report' },
];

// Spoofed school / teacher calls claiming a child is hurt or in trouble.
// Emotional pressure + wire or gift-card demand. Verification beats
// everything else — call the school's main switchboard directly.
const PARENT_TEACHER_SPECIFIC: StepTemplate[] = [
  { step_key: 'parent_teacher_call_switchboard', title: "Call the school's main switchboard yourself", body: "Look up the school's main number on the district website — not the number on your caller ID, and not a number the caller gave you. Ask the front office to confirm whether the call came from them.", time_sensitive: true, category: 'verify' },
  { step_key: 'parent_teacher_verify_child', title: 'Verify your child is safe on a trusted channel', body: "Call or FaceTime your child directly, or reach a co-parent, relative, or neighbor who can physically see them. A school would never ask for payment before letting you speak to your child.", time_sensitive: true, category: 'verify' },
  { step_key: 'parent_teacher_fcc_tcpa', title: 'File an FCC complaint — spoofed caller ID is a TCPA violation', body: "Spoofing a school's number to defraud a parent violates the Truth in Caller ID Act. Your complaint helps the FCC build enforcement cases against the spoofing service.", cta_label: 'FCC complaint', cta_url: FCC_COMPLAINT_URL, phone_to_call: FCC_PHONE, category: 'report' },
];

// Coinbase / Kraken / Binance support spoof. Key fact surfaced in the
// lead step: no major crypto exchange runs an inbound support phone line.
const COINBASE_SUPPORT_SPECIFIC: StepTemplate[] = [
  { step_key: 'coinbase_no_inbound_phone', title: 'No crypto exchange will EVER call you', body: "Coinbase, Kraken, Binance.US, and Gemini all handle support exclusively through web forms and in-app chat. Any phone number claiming to be crypto-exchange support is itself the scam — even if caller ID matches.", category: 'verify' },
  { step_key: 'coinbase_no_2fa_codes', title: 'Do NOT read your 2FA code or seed phrase to anyone', body: "Support will never ask for a 2FA code, recovery phrase, or private key. Reading any of these aloud hands the attacker full control of your wallet.", category: 'stop' },
  { step_key: 'coinbase_audit_sessions', title: 'Open the official app — audit sessions, API keys, and withdrawal whitelist', body: "Sign in to Coinbase via the app you already have installed (not a link). Check Security → Active sessions and revoke anything unfamiliar. Review API keys and the withdrawal allow-list for addresses you didn't add.", category: 'verify' },
  { step_key: 'coinbase_rotate_password_2fa', title: 'Rotate password and re-enroll 2FA', body: "Change the password from a device you trust, then remove and re-add your authenticator app. If SMS 2FA is the only option enabled, switch to an app-based authenticator today.", category: 'protect' },
];

// ============================================================================
//   Composition
// ============================================================================

export function stepsForScamType(
  type: ScamType | null | undefined,
  hasFamilyPlan: boolean,
  opts: { amountLost?: boolean; withinTimeWindow?: boolean } = {},
): StepTemplate[] {
  const effective: ScamType = (type ?? 'generic') as ScamType;
  const normalized: ScamType =
    effective === 'romance' ? 'romance_scam' :
    effective === 'investment' ? 'investment_scam' :
    effective;

  // Triage sessions have no step list — the Companion runs the show.
  // If someone calls stepsForScamType() before a triage session is
  // resolved, we return an empty list rather than silently emitting
  // the generic playbook (which would be the wrong content for a user
  // who hasn't yet confirmed anything happened).
  if (normalized === 'unknown_triage') {
    return [];
  }

  const steps: StepTemplate[] = [STOP_THE_CALL];

  switch (normalized) {
    // ---- Impersonation ----
    case 'bank_impersonation':
      steps.push(WIRE_RECALL, CALL_BANK_FRAUD, FREEZE_CARDS, CAPTURE_EVIDENCE,
        FREEZE_EQUIFAX, FREEZE_EXPERIAN, FREEZE_TRANSUNION,
        FTC_REPORT, IC3_REPORT, POLICE_REPORT);
      break;
    case 'bank_employee_impersonation':
      steps.push(...BANK_EMPLOYEE_SPECIFIC, CAPTURE_EVIDENCE, CALL_BANK_FRAUD,
        FREEZE_CARDS, CFPB_COMPLAINT, FTC_REPORT);
      break;
    case 'irs_impersonation':
      steps.push(TIGTA_REPORT, SSA_OIG_REPORT, CAPTURE_EVIDENCE,
        FREEZE_EQUIFAX, FREEZE_EXPERIAN, FREEZE_TRANSUNION,
        IDENTITY_THEFT_GOV, IRS_IP_PIN, FTC_REPORT);
      break;
    case 'irs_refund_bait':
      steps.push(TIGTA_REPORT, CAPTURE_EVIDENCE, IDENTITY_THEFT_GOV, IRS_IP_PIN, FTC_REPORT);
      break;
    case 'ssa_impersonation':
      steps.push(SSA_OIG_REPORT, IDENTITY_THEFT_GOV, CAPTURE_EVIDENCE,
        FREEZE_EQUIFAX, FREEZE_EXPERIAN, FREEZE_TRANSUNION, FTC_REPORT);
      break;
    case 'law_enforcement_impersonation':
      steps.push(
        { step_key: 'verify_warrant', title: 'Verify there is no warrant', body: "Real law enforcement never demands payment by phone. Call your local (non-emergency) police line — NOT a number the caller gave you.", category: 'verify' },
        CAPTURE_EVIDENCE, FTC_REPORT, FCC_COMPLAINT);
      break;
    case 'fbi_dea_impersonation':
      steps.push(...FBI_DEA_SPECIFIC, CAPTURE_EVIDENCE, FTC_REPORT, IC3_REPORT);
      break;
    case 'uscis_ice_impersonation':
      steps.push(...ICE_SPECIFIC, CAPTURE_EVIDENCE, FTC_REPORT, IC3_REPORT);
      break;
    case 'digital_arrest':
      steps.push(...DIGITAL_ARREST_SPECIFIC, CAPTURE_EVIDENCE, IC3_REPORT, FTC_REPORT);
      break;
    case 'medicare_impersonation':
      steps.push(...MEDICARE_SPECIFIC, CAPTURE_EVIDENCE,
        FREEZE_EQUIFAX, FREEZE_EXPERIAN, FREEZE_TRANSUNION, FTC_REPORT);
      break;
    case 'medicare_advantage_switch':
      steps.push(...MEDICARE_SPECIFIC, CAPTURE_EVIDENCE, FTC_REPORT);
      break;
    case 'utility_shutoff':
      steps.push(...UTILITY_SPECIFIC, CAPTURE_EVIDENCE, FTC_REPORT);
      break;

    // ---- Tech / credential theft ----
    case 'tech_support':
      steps.push(REMOVE_REMOTE_ACCESS, ROTATE_PASSWORDS, RECOVER_APPLE_ID, RECOVER_GOOGLE,
        SCAN_MALWARE, CAPTURE_EVIDENCE,
        FREEZE_EQUIFAX, FREEZE_EXPERIAN, FREEZE_TRANSUNION,
        FTC_REPORT, IC3_REPORT);
      break;
    case 'fake_refund_scam':
      steps.push(...FAKE_REFUND_SPECIFIC, REMOVE_REMOTE_ACCESS, ROTATE_PASSWORDS,
        CAPTURE_EVIDENCE, FTC_REPORT, IC3_REPORT);
      break;
    case 'apple_icloud_locked':
      steps.push(RECOVER_APPLE_ID, ROTATE_PASSWORDS, CAPTURE_EVIDENCE, FTC_REPORT);
      break;
    case 'google_account_takeover':
      steps.push(RECOVER_GOOGLE, ROTATE_PASSWORDS, CAPTURE_EVIDENCE, FTC_REPORT);
      break;
    case 'sim_swap_port_out':
      steps.push(CARRIER_PORT_FREEZE, ROTATE_PASSWORDS, CALL_BANK_FRAUD, FREEZE_CARDS,
        CAPTURE_EVIDENCE,
        FREEZE_EQUIFAX, FREEZE_EXPERIAN, FREEZE_TRANSUNION,
        FCC_COMPLAINT, IC3_REPORT, FTC_REPORT);
      break;
    case 'banking_app_push_bombing':
      steps.push(...BANKING_PUSH_BOMBING_SPECIFIC, ROTATE_PASSWORDS, CAPTURE_EVIDENCE, IC3_REPORT);
      break;
    case 'quishing_qr_phishing':
      steps.push(...QUISHING_SPECIFIC, ROTATE_PASSWORDS, CAPTURE_EVIDENCE, FTC_REPORT);
      break;
    case 'clickfix_malware':
      steps.push(...CLICKFIX_SPECIFIC, REMOVE_REMOTE_ACCESS, CAPTURE_EVIDENCE, IC3_REPORT, FTC_REPORT);
      break;
    case 'coinbase_support_spoof':
      steps.push(...COINBASE_SUPPORT_SPECIFIC, CRYPTO_FREEZE_EXCHANGE, CRYPTO_TRACE_WALLET,
        CAPTURE_EVIDENCE, IC3_REPORT, FTC_REPORT);
      break;

    // ---- Emotional ----
    case 'grandchild_emergency':
      steps.push(...GRANDCHILD_SPECIFIC, CAPTURE_EVIDENCE, FTC_REPORT);
      break;
    case 'ai_voice_clone_family':
      steps.push(...AI_VOICE_SPECIFIC, ...GRANDCHILD_SPECIFIC, CAPTURE_EVIDENCE, IC3_REPORT, FTC_REPORT);
      break;
    case 'virtual_kidnapping':
      steps.push(...VIRTUAL_KIDNAP_SPECIFIC, CAPTURE_EVIDENCE, IC3_REPORT, FTC_REPORT);
      break;
    case 'sextortion':
      steps.push(...SEXTORTION_SPECIFIC, CAPTURE_EVIDENCE, FTC_REPORT);
      break;
    case 'romance_scam':
      steps.push(...ROMANCE_SPECIFIC, CAPTURE_EVIDENCE,
        FREEZE_EQUIFAX, FREEZE_EXPERIAN, FREEZE_TRANSUNION,
        FTC_REPORT, IC3_REPORT);
      break;
    case 'pig_butchering':
      steps.push(...PIG_BUTCHER_SPECIFIC, CRYPTO_FREEZE_EXCHANGE, CRYPTO_TRACE_WALLET,
        CAPTURE_EVIDENCE, IC3_REPORT, IC3_FFKC_RAT, FTC_REPORT);
      break;
    case 'parent_teacher_spoof':
      steps.push(...PARENT_TEACHER_SPECIFIC, CAPTURE_EVIDENCE, WIRE_RECALL,
        FTC_REPORT, IC3_REPORT);
      break;

    // ---- Financial ----
    case 'zelle_venmo_support_scam':
      steps.push(...ZELLE_VENMO_SPECIFIC, CALL_BANK_FRAUD, REG_E_DISPUTE,
        CAPTURE_EVIDENCE, CFPB_COMPLAINT, FTC_REPORT);
      break;
    case 'bitcoin_atm_scam':
      steps.push(BITCOIN_KIOSK_CALL, ...BITCOIN_ATM_SPECIFIC, CRYPTO_TRACE_WALLET,
        CAPTURE_EVIDENCE, IC3_REPORT, FTC_REPORT);
      break;
    case 'gift_card_scam':
      steps.push(GIFT_CARD_FREEZE_APPLE, GIFT_CARD_FREEZE_GOOGLE, GIFT_CARD_FREEZE_AMAZON,
        GIFT_CARD_FREEZE_OTHER, CAPTURE_EVIDENCE, FTC_REPORT);
      break;
    case 'investment_scam':
      steps.push(...INVESTMENT_SPECIFIC, CRYPTO_TRACE_WALLET, CAPTURE_EVIDENCE,
        FREEZE_EQUIFAX, FREEZE_EXPERIAN, FREEZE_TRANSUNION,
        FTC_REPORT, IC3_REPORT);
      break;
    case 'crypto_scam':
      steps.push(CRYPTO_FREEZE_EXCHANGE, CRYPTO_TRACE_WALLET, CAPTURE_EVIDENCE,
        ROTATE_PASSWORDS, IC3_REPORT, FTC_REPORT, POLICE_REPORT);
      break;
    case 'brokerage_401k_phishing':
      steps.push(...BROKERAGE_401K_SPECIFIC, CAPTURE_EVIDENCE,
        FREEZE_EQUIFAX, FREEZE_EXPERIAN, FREEZE_TRANSUNION,
        IC3_REPORT, FTC_REPORT);
      break;
    case 'debt_collection_phantom':
      steps.push(...DEBT_PHANTOM_SPECIFIC, CAPTURE_EVIDENCE, FTC_REPORT, STATE_AG_REPORT);
      break;
    case 'car_warranty_expiration':
      steps.push(...CAR_WARRANTY_SPECIFIC, FTC_DNC, CAPTURE_EVIDENCE, FTC_REPORT);
      break;
    case 'home_warranty_scam':
      steps.push(FREEZE_CARDS, CAPTURE_EVIDENCE, STATE_AG_REPORT, FTC_REPORT);
      break;
    case 'subscription_trap':
      steps.push(...SUBSCRIPTION_SPECIFIC, CAPTURE_EVIDENCE, FTC_REPORT);
      break;
    case 'advance_fee_inheritance':
      steps.push(...INHERITANCE_SPECIFIC, CAPTURE_EVIDENCE, FTC_REPORT, IC3_REPORT);
      break;
    case 'lottery_sweepstakes':
      steps.push(...LOTTERY_SPECIFIC, CAPTURE_EVIDENCE, FTC_REPORT, STATE_AG_REPORT);
      break;

    // ---- Services / property ----
    case 'employment_scam':
      steps.push(...EMPLOYMENT_SPECIFIC, FREEZE_CARDS, CAPTURE_EVIDENCE, FTC_REPORT, IC3_REPORT);
      break;
    case 'rental_scam':
      steps.push(...RENTAL_SPECIFIC, CAPTURE_EVIDENCE, FTC_REPORT, IC3_REPORT);
      break;
    case 'timeshare_resale':
      steps.push(...TIMESHARE_SPECIFIC, CAPTURE_EVIDENCE, FTC_REPORT, STATE_AG_REPORT);
      break;
    case 'solar_panel_scam':
      steps.push(...SOLAR_SPECIFIC, CAPTURE_EVIDENCE, STATE_AG_REPORT, CFPB_COMPLAINT, FTC_REPORT);
      break;
    case 'moving_company_hostage':
      steps.push(...MOVING_SPECIFIC, CAPTURE_EVIDENCE, STATE_AG_REPORT, FTC_REPORT);
      break;
    case 'home_repair_storm_chaser':
      steps.push(...HOME_REPAIR_SPECIFIC, CAPTURE_EVIDENCE, STATE_AG_REPORT, FTC_REPORT);
      break;
    case 'funeral_cremation_scam':
      steps.push(...FUNERAL_SPECIFIC, CAPTURE_EVIDENCE, STATE_AG_REPORT, FTC_REPORT);
      break;
    case 'pet_scam':
      steps.push(...PET_SPECIFIC, FREEZE_CARDS, CAPTURE_EVIDENCE, IC3_REPORT, FTC_REPORT);
      break;

    // ---- Health / benefits / education ----
    case 'student_loan_forgiveness':
      steps.push(...STUDENT_LOAN_SPECIFIC, CAPTURE_EVIDENCE, FTC_REPORT);
      break;
    case 'veterans_benefits_buyout':
      steps.push(...VETERANS_SPECIFIC, CAPTURE_EVIDENCE, CFPB_COMPLAINT, FTC_REPORT, STATE_AG_REPORT);
      break;
    case 'affordable_care_act_scam':
      steps.push(...ACA_SPECIFIC, CAPTURE_EVIDENCE, STATE_AG_REPORT, FTC_REPORT);
      break;
    case 'tax_prep_identity_theft':
      steps.push(...TAX_PREP_SPECIFIC, IDENTITY_THEFT_GOV, IRS_IP_PIN,
        FREEZE_EQUIFAX, FREEZE_EXPERIAN, FREEZE_TRANSUNION,
        CAPTURE_EVIDENCE, FTC_REPORT);
      break;

    // ---- Civic / seasonal ----
    case 'charity_scam':
      steps.push(...CHARITY_SPECIFIC, CAPTURE_EVIDENCE, FTC_REPORT);
      break;
    case 'political_donation_scam_pac':
      steps.push(...POLITICAL_SPECIFIC, CAPTURE_EVIDENCE, FTC_REPORT, STATE_AG_REPORT);
      break;
    case 'census_survey_scam':
      steps.push(...CENSUS_SPECIFIC, CAPTURE_EVIDENCE,
        FREEZE_EQUIFAX, FREEZE_EXPERIAN, FREEZE_TRANSUNION, FTC_REPORT);
      break;
    case 'fema_disaster_relief_fraud':
      steps.push(...FEMA_SPECIFIC, CAPTURE_EVIDENCE, FTC_REPORT);
      break;

    // ---- Text / smishing ----
    case 'package_redelivery':
      steps.push(ROTATE_PASSWORDS, RECOVER_APPLE_ID, RECOVER_GOOGLE,
        CAPTURE_EVIDENCE, USPIS_REPORT, FTC_REPORT);
      break;
    case 'unpaid_toll':
      steps.push(
        { step_key: 'toll_verify', title: 'Check your toll account directly', body: "Log in to EZPass/SunPass/FasTrak directly — NOT via the text link. Real toll agencies bill by mail or through your saved online account.", category: 'verify' },
        FREEZE_CARDS, CAPTURE_EVIDENCE, FTC_REPORT);
      break;

    // ---- Re-victimization ----
    case 'recovery_scam_secondary':
      steps.push(...RECOVERY_SCAM_SPECIFIC, CAPTURE_EVIDENCE, FTC_REPORT, IC3_REPORT);
      break;

    case 'generic':
    default:
      steps.push(CAPTURE_EVIDENCE,
        FREEZE_EQUIFAX, FREEZE_EXPERIAN, FREEZE_TRANSUNION,
        FTC_REPORT, IC3_REPORT);
      break;
  }

  // Every session gets the recovery-scam warning near the end — victims
  // are the #1 target of the NEXT scam call.
  steps.push(RECOVERY_SCAM_WARNING);
  // Identity-fraud coverage is commonly bundled with homeowners/renters
  // policies and routinely missed. Only surface when money was lost.
  if (opts.amountLost) steps.push(HOMEOWNERS_INSURANCE_CHECK);
  if (hasFamilyPlan) steps.push(FAMILY_NOTIFY);
  steps.push(AARP_HOTLINE, VICTIM_SUPPORT);

  if (opts.amountLost && opts.withinTimeWindow) {
    const head = steps.slice(0, 1);
    const rest = steps.slice(1);
    const urgent = rest.filter((s) => s.time_sensitive);
    const normal = rest.filter((s) => !s.time_sensitive);
    return [...head, ...urgent, ...normal];
  }
  return steps;
}
