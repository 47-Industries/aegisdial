// Short human descriptions of each scam type — fed to the Recovery
// Companion system prompt so the AI can ground its responses in what
// this specific scam actually looks like. Kept separate from
// recoverySteps.ts (which defines the step catalog) so both files can be
// edited independently.
//
// Descriptions are deliberately short (one sentence) and in plain
// language the victim themselves would use, not clinical fraud-terminology.

export const SCAM_TYPE_DESCRIPTIONS: Record<string, string> = {
  // Impersonation
  bank_impersonation:
    'a caller pretending to be from the victim\'s bank, usually with an urgent "suspicious activity" story designed to move money to a "safe account."',
  bank_employee_impersonation:
    'a caller claiming to be the victim\'s own bank fraud team — they "confirm" account details to build trust before asking the victim to wire money or move funds.',
  irs_impersonation:
    'a caller pretending to be the IRS, threatening arrest or deportation over back taxes, demanding immediate payment by wire or gift card.',
  irs_refund_bait:
    'a caller claiming the victim is owed an IRS refund and asking for bank or SSN details to "deposit" it.',
  ssa_impersonation:
    'a caller pretending to be Social Security, claiming the victim\'s SSN has been "suspended" or linked to crimes in Texas.',
  law_enforcement_impersonation:
    'a caller pretending to be a local officer or sheriff, claiming a warrant or missed jury duty and demanding immediate payment.',
  fbi_dea_impersonation:
    'a caller pretending to be FBI or DEA, usually saying the victim\'s name is linked to drug money or an ongoing federal investigation.',
  uscis_ice_impersonation:
    'a caller pretending to be ICE or USCIS, threatening deportation or immigration-status trouble to extract payment or personal info.',
  digital_arrest:
    'a pressure scam where the caller claims the victim is under "digital house arrest" and must stay on the line (sometimes for hours) while paying a "clearance."',
  medicare_impersonation:
    'a caller pretending to be Medicare, asking for the victim\'s Medicare number "to update their card" or "unlock benefits."',
  medicare_advantage_switch:
    'a pressure call to switch the victim into a different Medicare Advantage plan, usually misrepresenting coverage or costs.',
  utility_shutoff:
    'a caller pretending to be a power/gas/water utility, threatening shutoff within minutes unless payment is made by gift card or prepaid card.',

  // Tech / credential theft
  tech_support:
    'a caller pretending to be Apple, Microsoft, or an ISP tech-support agent, talking the victim into installing remote-access software so they can drain accounts.',
  fake_refund_scam:
    'a caller claims an accidental overpayment on a refund (often Amazon / Best Buy / Geek Squad) and tries to have the victim wire the "extra" back.',
  apple_icloud_locked:
    'a caller or pop-up saying the victim\'s Apple ID or iCloud is locked, trying to harvest the password + 2FA code.',
  google_account_takeover:
    'a phishing flow (call or text) designed to harvest Google account credentials and the 2FA prompt, usually disguised as a security alert.',
  sim_swap_port_out:
    'an attacker convinces the carrier to port the victim\'s phone number to their own SIM, then intercepts banking 2FA codes.',
  banking_app_push_bombing:
    'the attacker spams the victim with banking app MFA push prompts until the victim taps "approve" out of exhaustion.',
  quishing_qr_phishing:
    'a QR code (in mail, a parking meter sticker, or an email) that routes to a phishing page harvesting credentials.',
  clickfix_malware:
    'a fake "verify you are human" or "fix your browser" prompt that tricks the victim into copy-pasting a malicious command into Terminal or PowerShell.',
  brokerage_401k_phishing:
    'a "your retirement is in danger" call that tries to get the victim to move or liquidate a Fidelity / Vanguard / Schwab / 401(k) balance.',

  // Emotional
  grandchild_emergency:
    'a caller pretending to be a grandchild (or their lawyer) in trouble — arrested, in a hospital, stranded — who urgently needs money.',
  ai_voice_clone_family:
    'same as grandchild_emergency but using AI to clone a real family member\'s voice from social media audio.',
  virtual_kidnapping:
    'a terrifying call claiming a family member has been kidnapped, demanding ransom while keeping the victim on the phone so they can\'t verify.',
  sextortion:
    'an extortion scheme based on real or fabricated intimate images, threatening to share them unless the victim pays.',
  romance_scam:
    'a long-running online relationship where the "partner" eventually asks for money for an emergency that never resolves.',
  pig_butchering:
    'a long-running trust-building scam (often months) that gradually draws the victim into fake crypto or forex investment platforms that show fake gains.',
  parent_teacher_spoof:
    'a caller spoofing a school\'s phone number, claiming the victim\'s child is injured or in trouble and demanding an immediate wire or gift card.',

  // Financial
  zelle_venmo_support_scam:
    'a caller pretending to be Zelle / Venmo / Cash App "support" after the victim reports a scam, tricking them into sending more money as a "refund test."',
  bitcoin_atm_scam:
    'the victim is instructed to feed cash into a Bitcoin ATM kiosk under some pretext (IRS, warrant, family emergency).',
  gift_card_scam:
    'the victim is told to buy gift cards (Apple, Google Play, Amazon, Target, Walmart) and read the codes to the scammer.',
  investment_scam:
    'a pitch for an unregistered investment (usually high-yield, "guaranteed," often crypto) that turns out to be fraudulent.',
  crypto_scam:
    'any of several crypto-specific scams — fake exchange, wallet drainer, rug-pull, or exchange impersonator.',
  coinbase_support_spoof:
    'a caller pretending to be Coinbase Security (Coinbase has no inbound phone support), aiming to steal seed phrases, 2FA, or trick the victim into moving crypto.',
  debt_collection_phantom:
    'a caller demanding payment on a debt the victim doesn\'t recognize, using threats or fake legal consequences.',
  car_warranty_expiration:
    'a caller claiming the victim\'s car warranty is about to expire, selling a fake or useless extended warranty.',
  home_warranty_scam:
    'similar to car warranty but for home systems — unsolicited calls selling worthless or fake service agreements.',
  subscription_trap:
    'an unauthorized or hard-to-cancel subscription charge, often after a "free trial" or a phished checkout.',
  advance_fee_inheritance:
    'a caller claims the victim is owed an inheritance / lottery / relief fund but must pay fees up front to release it.',
  lottery_sweepstakes:
    'a caller claims the victim won a lottery or sweepstakes but must pay taxes or fees before collecting.',

  // Services / property
  employment_scam:
    'a fake job offer (often remote / "reshipper" / "payment processor") that exists only to harvest SSN, bank info, or use the victim as a money mule.',
  rental_scam:
    'a fake rental listing (Craigslist, Zillow, FB Marketplace) collecting deposits for a property the scammer doesn\'t own.',
  timeshare_resale:
    'a caller claims they have a buyer for the victim\'s timeshare but demands an upfront "closing" fee that disappears.',
  solar_panel_scam:
    'a door-to-door or cold-call solar pitch that locks the homeowner into predatory financing or non-existent install contracts.',
  moving_company_hostage:
    'a mover gives a low quote, then after loading the truck demands much more "or your belongings stay in our warehouse."',
  home_repair_storm_chaser:
    'post-disaster contractors who take money for roof / tree / water damage repairs and either don\'t do the work or do it badly.',
  funeral_cremation_scam:
    'upselling or fake fee charges on top of funeral / cremation arrangements during bereavement.',
  pet_scam:
    'a fake online pet sale that collects deposits, shipping fees, "insurance," etc., for a pet that doesn\'t exist.',

  // Health / benefits / education
  student_loan_forgiveness:
    'a caller promises to "forgive" the victim\'s student loans for an upfront fee — federal forgiveness is always free to apply for.',
  veterans_benefits_buyout:
    'a caller offers a lump-sum "buyout" in exchange for signing over future VA benefits payments.',
  affordable_care_act_scam:
    'a caller offers fake ACA health plans or threatens penalties for being uninsured to harvest personal info.',
  tax_prep_identity_theft:
    'a "tax preparer" files a fake return in the victim\'s name to harvest the refund.',

  // Civic / seasonal
  charity_scam:
    'solicitations for fake charities — often around disasters, holidays, or a recent news event.',
  political_donation_scam_pac:
    'solicitations from fake PACs or stolen-identity PACs that pocket the donations without campaign activity.',
  census_survey_scam:
    'a caller pretends to be the US Census Bureau to harvest SSN or bank details.',
  fema_disaster_relief_fraud:
    'a caller pretending to be FEMA who offers disaster aid in exchange for an upfront fee or personal info.',

  // Text / smishing
  package_redelivery:
    'a text claiming a USPS / UPS / FedEx package can\'t be delivered, linking to a phishing page asking for a "redelivery fee" or account details.',
  unpaid_toll:
    'a text claiming unpaid E-ZPass / SunPass / FasTrak tolls, linking to a phishing page that harvests card info.',

  // Re-victimization
  recovery_scam_secondary:
    'a caller (or agency) who claims they can "get back the money you lost" — usually after identifying the victim as a recent scam target — for an upfront fee.',

  unknown_triage:
    'an unsolicited contact the person is still evaluating — they haven\'t confirmed whether it was a scam yet, and the Companion is in triage mode helping them figure it out.',

  generic:
    'an unwanted or suspicious phone call that the victim believes was a scam but isn\'t sure of the specific category.',

  // Legacy aliases
  romance: 'a long-running online relationship that eventually asks for money.',
  investment: 'a pitch for a fraudulent investment opportunity.',
};

export function describeScamType(type: string | null | undefined): string {
  if (!type) return SCAM_TYPE_DESCRIPTIONS.generic!;
  return SCAM_TYPE_DESCRIPTIONS[type] ?? SCAM_TYPE_DESCRIPTIONS.generic!;
}
