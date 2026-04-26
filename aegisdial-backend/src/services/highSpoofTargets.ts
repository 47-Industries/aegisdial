import type { BusinessCategory } from '../types.js';

// High-spoof target registry. Every entry here is a real US institution
// whose phone numbers are routinely spoofed. When a verdict lookup matches
// one of these numbers, we tag the response with business_match so the app
// can show the verified-business-spoof UI ("This IS the real Chase line,
// but scammers spoof it — hang up and call back on the number on your
// card").
//
// CRITICAL: every `verified_numbers` entry below is a REAL, PUBLIC number
// pulled from the institution's official website. If any number is wrong,
// we'd mark a scammer-spoofed call as "trusted," which is literally the
// worst possible output. If you're editing this list, verify each number
// against the institution's current `/contact` page before merging.
//
// Numbers are in E.164 format (+1XXXXXXXXXX). Categories keyed by enum in
// src/types.ts BusinessCategoryEnum.

export interface SpoofTargetEntry {
  name: string;
  category: BusinessCategory;
  verified_numbers: string[];
  spoof_message: string;
  // Optional: the institution's public contact / customer-service page.
  // The daily verifier job scrapes these and alerts on drift. Leave
  // undefined to skip verification for an entry (useful when a page is
  // JS-rendered or gated). Add as many URLs as are authoritative — e.g.
  // a bank's main contact page plus its separate fraud/cards page.
  contact_urls?: string[];
}

export const HIGH_SPOOF_TARGETS: SpoofTargetEntry[] = [
  {
    name: 'Bank of America',
    category: 'bank',
    verified_numbers: [
      '+18004321000', '+18004636262',
      '+18009322775', '+18662834075', '+18005180479', '+12099445278',
    ],
    spoof_message:
      'This IS the real Bank of America line — but scammers frequently spoof it. If this call was unexpected, HANG UP and call the number on the back of your card.',
    contact_urls: ['https://www.bankofamerica.com/customer-service/contact-us/about-bank-of-america/'],
  },
  {
    name: 'Chase',
    category: 'bank',
    verified_numbers: ['+18009359935', '+18004313117', '+18665642262'],
    spoof_message:
      'This IS the real Chase line — but scammers frequently spoof it. If this call was unexpected, HANG UP and call the number on the back of your card.',
    contact_urls: ['https://www.jpmorgan.com/contact-us'],
  },
  {
    name: 'Wells Fargo',
    category: 'bank',
    verified_numbers: [
      '+18008693557', '+18008722657',
      '+18007424832', '+18006424720', '+18009679521', '+18775171358',
      '+18779379357', '+18668209199', '+18005775313', '+18668636762',
      '+18882458454', '+18668675568', '+18666093037',
    ],
    spoof_message:
      'This IS the real Wells Fargo line — but scammers frequently spoof it. If this call was unexpected, HANG UP and call the number on the back of your card.',
    contact_urls: ['https://www.wellsfargo.com/help/contact-us/'],
  },
  {
    name: 'Citibank',
    category: 'bank',
    verified_numbers: [
      '+18003744000',
      '+18009505514', '+18003252865', '+18136043038', '+18006698488',
      '+18008157701', '+18776403983', '+18007326000', '+18775280990',
      '+18009177700', '+18553786467',
    ],
    spoof_message:
      'This IS the real Citibank line — but scammers frequently spoof it. If unexpected, HANG UP and call the number on the back of your card.',
    contact_urls: ['https://contactcitigold.citi.com/'],
  },
  {
    name: 'American Express',
    category: 'credit_card',
    verified_numbers: [
      '+18005281000', '+18002974541',
      '+18004452639', '+18885562436', '+18005284800', '+18772393491',
      '+18882971244',
    ],
    spoof_message:
      'This IS the real American Express line — but scammers frequently spoof it. If unexpected, HANG UP and call the number on the back of your card.',
    contact_urls: [
      'https://www.americanexpress.com/us/customer-service/',
    ],
  },
  {
    name: 'Capital One',
    category: 'credit_card',
    // Corrected 2026-04-17 by the verifier: the old +18002278347 entry was
    // a typo (correct CAPITAL-1 T9 encoding = 227-4825). Live verification
    // confirmed +18002274825 appears on capitalone.com/contact/.
    verified_numbers: ['+18002274825', '+18006552265'],
    spoof_message:
      'This IS the real Capital One line — but scammers frequently spoof it. If unexpected, HANG UP and call the number on the back of your card.',
    contact_urls: [
      'https://www.capitalone.com/contact/',
    ],
  },
  {
    name: 'Discover',
    category: 'credit_card',
    verified_numbers: ['+18003472683'],
    spoof_message:
      'This IS the real Discover line — but scammers frequently spoof it. If unexpected, HANG UP and call the number on the back of your card.',
    contact_urls: [
      'https://www.discover.com/credit-cards/help-center/contact-us/',
    ],
  },
  {
    name: 'IRS',
    category: 'government',
    verified_numbers: ['+18008291040', '+18008294933'],
    spoof_message:
      'This matches the real IRS number. The IRS will NEVER call demanding payment or threaten arrest. Hang up and call 1-800-829-1040 directly.',
    contact_urls: ['https://www.irs.gov/help/telephone-assistance'],
  },
  {
    name: 'Social Security Administration',
    category: 'government',
    verified_numbers: ['+18007721213'],
    spoof_message:
      'This matches the real SSA number. The SSA will NEVER threaten to suspend your Social Security number. Hang up and call 1-800-772-1213 directly.',
    contact_urls: ['https://www.ssa.gov/agency/contact/'],
  },
  {
    name: 'Medicare',
    category: 'government',
    verified_numbers: ['+18006334227'],
    spoof_message:
      'This matches the real Medicare number. Medicare will NEVER call asking for your Medicare number or bank info. Hang up and call 1-800-MEDICARE.',
    contact_urls: ['https://www.medicare.gov/talk-to-someone'],
  },
  {
    name: 'USPS',
    category: 'shipping',
    verified_numbers: ['+18002758777'],
    spoof_message:
      'This matches the real USPS line. USPS does not call about package redirects or unpaid postage. Never click texted links — track via usps.com.',
    contact_urls: ['https://www.usps.com/help/contact-us.htm'],
  },
  {
    name: 'FedEx',
    category: 'shipping',
    verified_numbers: ['+18004633339'],
    spoof_message:
      'This matches a real FedEx line but is heavily spoofed in package-redirect scams. Track packages only via the official FedEx app.',
    contact_urls: ['https://www.fedex.com/en-us/customer-support/contact.html'],
  },
  {
    name: 'UPS',
    category: 'shipping',
    verified_numbers: ['+18007425877'],
    spoof_message:
      'This matches a real UPS line but is heavily spoofed. Track packages only via the official UPS app.',
    contact_urls: ['https://www.ups.com/us/en/support/contact-us.page'],
  },
  {
    name: 'Amazon',
    category: 'big_tech',
    verified_numbers: ['+18882804331', '+18662167002'],
    spoof_message:
      'This matches a real Amazon support line, but Amazon refund-scam calls are rampant. Hang up and contact Amazon only through your account in the app.',
    contact_urls: ['https://www.amazon.com/gp/help/customer/contact-us'],
  },
  {
    name: 'Apple Support',
    category: 'big_tech',
    verified_numbers: ['+18002752273', '+18002374444'],
    spoof_message:
      'This matches the real Apple Support line, but scammers spoof it for iCloud scams. Apple will not call you unsolicited. Hang up and use the Apple Support app.',
    contact_urls: ['https://getsupport.apple.com/'],
  },
  {
    name: 'Microsoft Support',
    category: 'big_tech',
    verified_numbers: ['+18006427676'],
    spoof_message:
      'Microsoft does NOT make unsolicited support calls. If you did not request a callback, this is almost certainly a scam. Hang up.',
    contact_urls: ['https://support.microsoft.com/en-us/contactus'],
  },
  {
    name: 'Google',
    category: 'big_tech',
    verified_numbers: ['+18002530000'],
    spoof_message:
      'Google does not make unsolicited phone calls to consumers. If unexpected, hang up.',
    contact_urls: ['https://support.google.com/'],
  },
  {
    name: 'AT&T',
    category: 'telecom',
    verified_numbers: ['+18002882020', '+18003581111', '+18777892877'],
    spoof_message:
      'This matches a real AT&T line, but is heavily spoofed. Verify any account issue via myAT&T app or att.com.',
    contact_urls: ['https://www.att.com/support/contact-us/'],
  },
  {
    name: 'Verizon',
    category: 'telecom',
    verified_numbers: ['+18009220204', '+18004608839'],
    spoof_message:
      'This matches a real Verizon line, but is heavily spoofed. Verify any account issue via My Verizon app or verizon.com.',
    contact_urls: ['https://www.verizon.com/support/contact-us/'],
  },
  {
    name: 'T-Mobile',
    category: 'telecom',
    verified_numbers: ['+18009378997'],
    spoof_message:
      'This matches a real T-Mobile line, but is heavily spoofed. Verify any account issue via the T-Mobile app.',
    contact_urls: ['https://www.t-mobile.com/contact-us'],
  },
  {
    name: 'TurboTax',
    category: 'tax_prep',
    verified_numbers: ['+18004468848'],
    spoof_message:
      'This matches a real TurboTax line but is spoofed in tax-season scams. Never share your refund info over an inbound call.',
    contact_urls: ['https://support.turbotax.intuit.com/contact/'],
  },
  {
    name: 'H&R Block',
    category: 'tax_prep',
    verified_numbers: ['+18004729297'],
    spoof_message:
      'This matches a real H&R Block line but is spoofed in tax-season scams. Visit hrblock.com to verify.',
    contact_urls: ['https://www.hrblock.com/support/'],
  },

  // ===== Additional top-30 US banks (added 2026-04-17) =====

  {
    name: 'US Bank',
    category: 'bank',
    verified_numbers: ['+18008722657', '+18002858585'],
    spoof_message:
      'This IS the real US Bank line — but scammers frequently spoof it. If unexpected, HANG UP and call the number on the back of your card.',
    contact_urls: ['https://www.usbank.com/customer-service.html'],
  },
  {
    name: 'PNC Bank',
    category: 'bank',
    verified_numbers: ['+18887622265', '+18005018749', '+18667624000'],
    spoof_message:
      'This IS the real PNC line — but scammers frequently spoof it. If unexpected, HANG UP and call the number on the back of your card.',
    contact_urls: ['https://www.pnc.com/en/customer-service/contact-us.html'],
  },
  {
    name: 'Truist',
    category: 'bank',
    verified_numbers: ['+18444878478', '+18882286654', '+18662382420'],
    spoof_message:
      'This IS the real Truist line — but scammers frequently spoof it. If unexpected, HANG UP and call the number on the back of your card.',
    contact_urls: ['https://www.truist.com/contact'],
  },
  {
    name: 'TD Bank',
    category: 'bank',
    verified_numbers: [
      '+18887519000',
      '+18885618861', '+18662223456', '+18007422651', '+18777002913',
    ],
    spoof_message:
      'This IS the real TD Bank line — but scammers frequently spoof it. If unexpected, HANG UP and call the number on the back of your card.',
    contact_urls: ['https://www.td.com/us/en/personal-banking/contact-us'],
  },
  {
    name: 'Ally Bank',
    category: 'bank',
    verified_numbers: ['+18772472559', '+18889252559'],
    spoof_message:
      'This IS the real Ally Bank line — but scammers frequently spoof it. If unexpected, HANG UP and log into Ally.com or the app to verify.',
    contact_urls: ['https://www.ally.com/contact-us/'],
  },
  {
    name: 'Charles Schwab',
    category: 'bank',
    verified_numbers: [
      '+18004354000', '+18886866916',
      '+18888629680', '+18884039000', '+18775191403', '+18662329890',
    ],
    spoof_message:
      'This IS the real Charles Schwab line — but scammers frequently spoof it. Never move money because of an inbound call. Hang up and call back on the number on your statement.',
    contact_urls: [
      'https://www.schwab.com/contact-us',
    ],
  },
  {
    name: 'HSBC Bank USA',
    category: 'bank',
    verified_numbers: ['+18009754722', '+18665844722', '+18774722249'],
    spoof_message:
      'This IS the real HSBC line — but scammers frequently spoof it. If unexpected, HANG UP and call the number on the back of your card.',
    contact_urls: ['https://www.us.hsbc.com/customer-service/'],
  },
  {
    name: 'Citizens Bank',
    category: 'bank',
    verified_numbers: ['+18009229999'],
    spoof_message:
      'This IS the real Citizens Bank line — but scammers frequently spoof it. If unexpected, HANG UP and call the number on the back of your card.',
    contact_urls: ['https://www.citizensbank.com/customer-service/contact-us.aspx'],
  },
  {
    name: 'Fifth Third Bank',
    category: 'bank',
    verified_numbers: [
      '+18009723030',
      '+18778336197', '+18775342264', '+15139003080',
    ],
    spoof_message:
      'This IS the real Fifth Third line — but scammers frequently spoof it. If unexpected, HANG UP and call the number on the back of your card.',
    contact_urls: ['https://www.53.com/content/fifth-third/en/customer-service.html'],
  },
  {
    name: 'KeyBank',
    category: 'bank',
    verified_numbers: ['+18005392968', '+18662952955'],
    spoof_message:
      'This IS the real KeyBank line — but scammers frequently spoof it. If unexpected, HANG UP and call the number on the back of your card.',
    contact_urls: ['https://www.key.com/about/customer-service/contactus.html'],
  },
  {
    name: 'M&T Bank',
    category: 'bank',
    verified_numbers: ['+18007242440'],
    spoof_message:
      'This IS the real M&T Bank line — but scammers frequently spoof it. If unexpected, HANG UP and call the number on the back of your card.',
    contact_urls: ['https://www.mtb.com/help-center/contact-us'],
  },
  {
    name: 'Regions Bank',
    category: 'bank',
    verified_numbers: ['+18007344667', '+18004722265'],
    spoof_message:
      'This IS the real Regions Bank line — but scammers frequently spoof it. If unexpected, HANG UP and call the number on the back of your card.',
    contact_urls: ['https://www.regions.com/help/contact-us-by-phone'],
  },
  {
    name: 'Huntington Bancshares',
    category: 'bank',
    verified_numbers: ['+18004802265'],
    spoof_message:
      'This IS the real Huntington line — but scammers frequently spoof it. If unexpected, HANG UP and call the number on the back of your card.',
    contact_urls: ['https://www.huntington.com/Customer-service'],
  },
  {
    name: 'Comerica',
    category: 'bank',
    verified_numbers: ['+18002663742'],
    spoof_message:
      'This IS the real Comerica line — but scammers frequently spoof it. If unexpected, HANG UP and call the number on the back of your card.',
    contact_urls: ['https://www.comerica.com/site-tools/resources/contact-us.html'],
  },
  {
    name: 'Santander Bank US',
    category: 'bank',
    verified_numbers: ['+18777682265'],
    spoof_message:
      'This IS the real Santander line — but scammers frequently spoof it. If unexpected, HANG UP and call the number on the back of your card.',
    contact_urls: ['https://www.santanderbank.com/personal/customer-service/contact-us'],
  },
  {
    name: 'BMO Bank',
    category: 'bank',
    verified_numbers: ['+18883402265'],
    spoof_message:
      'This IS the real BMO line — but scammers frequently spoof it. If unexpected, HANG UP and call the number on the back of your card.',
    contact_urls: ['https://www21.bmo.com/content/en/contactus.html'],
  },

  // ===== Credit unions =====

  {
    name: 'Navy Federal Credit Union',
    category: 'credit_union',
    verified_numbers: [
      '+18888426328', '+18882412510',
      '+18774181462', '+18772218108', '+18554771138',
      '+18663041909', '+18662627438',
    ],
    spoof_message:
      'This IS the real Navy Federal line — but Navy Federal members are a top scam target (especially service-members and veterans). HANG UP and call 1-888-842-6328 or log into the app.',
    contact_urls: ['https://www.navyfederal.org/contact-us.html'],
  },
  {
    name: 'USAA',
    category: 'credit_union',
    verified_numbers: [
      '+18005318722', '+18777627256',
      '+12105318722', '+18776272811', '+18554308489', '+18448250315',
      '+18444559180', '+18005319940', '+18007939034',
      '+12103019947', '+12102822394',
    ],
    spoof_message:
      'This IS the real USAA line — but USAA members (service-members, veterans, families) are a top scam target. HANG UP and call 1-800-531-USAA or log into the app.',
    contact_urls: ['https://www.usaa.com/help/contact/'],
  },
  {
    name: 'PenFed Credit Union',
    category: 'credit_union',
    verified_numbers: ['+18002475626'],
    spoof_message:
      'This IS the real PenFed line — but scammers frequently spoof it. If unexpected, HANG UP and call 1-800-247-5626 directly.',
    contact_urls: ['https://www.penfed.org/contact-us'],
  },
  {
    name: 'BECU',
    category: 'credit_union',
    verified_numbers: ['+18002332328'],
    spoof_message:
      'This IS the real BECU line — but scammers frequently spoof it. If unexpected, HANG UP and call 1-800-233-2328 directly.',
    contact_urls: ['https://www.becu.org/support/contact-us'],
  },
  {
    name: 'Alliant Credit Union',
    category: 'credit_union',
    verified_numbers: ['+18003281935'],
    spoof_message:
      'This IS the real Alliant Credit Union line — but scammers frequently spoof it. If unexpected, HANG UP and call 1-800-328-1935 directly.',
    contact_urls: ['https://www.alliantcreditunion.org/help/contact'],
  },

  // ===== Fintech / neobanks =====

  {
    name: 'Marcus by Goldman Sachs',
    category: 'fintech',
    verified_numbers: ['+18557307283'],
    spoof_message:
      'This IS the real Marcus line — but scammers frequently spoof it. Marcus will never ask you to move funds over the phone. If unexpected, HANG UP and log into the Marcus app.',
    contact_urls: ['https://www.marcus.com/us/en/banking-with-us/contact-marcus'],
  },
  {
    name: 'SoFi',
    category: 'fintech',
    verified_numbers: [
      '+18554567634',
      '+18449457634', '+18555257634', '+18447634466',
    ],
    spoof_message:
      'This IS the real SoFi line — but scammers frequently spoof it. If unexpected, HANG UP and log into the SoFi app to verify.',
    contact_urls: ['https://www.sofi.com/contact-us/'],
  },
  {
    name: 'Chime',
    category: 'fintech',
    verified_numbers: ['+18442446363'],
    spoof_message:
      'This IS the real Chime line — but Chime users are a top phone-scam target. Chime will NEVER ask for your password, PIN, or one-time code. HANG UP and use the in-app chat.',
    contact_urls: ['https://help.chime.com/hc/en-us'],
  },

  // ===== P2P payments =====

  {
    name: 'PayPal',
    category: 'p2p_payments',
    verified_numbers: ['+18882211161'],
    spoof_message:
      'This IS the real PayPal line — but PayPal users are a top phone-scam target. PayPal will NEVER call to ask for passwords, codes, or to move money. HANG UP and log into paypal.com.',
    contact_urls: ['https://www.paypal.com/us/smarthelp/contact-us'],
  },
  {
    name: 'Venmo',
    category: 'p2p_payments',
    verified_numbers: ['+18558124430'],
    spoof_message:
      'This IS the real Venmo line — but scammers frequently spoof it. Venmo will NEVER ask you to send yourself money. HANG UP and use the in-app chat.',
    contact_urls: ['https://help.venmo.com/hc/en-us/articles/221410668-Contact-Us'],
  },
  {
    name: 'Cash App',
    category: 'p2p_payments',
    verified_numbers: ['+18009691940'],
    spoof_message:
      'Cash App has very limited phone support — they will NEVER call you first. If you receive an unsolicited call claiming to be Cash App, it is a scam. HANG UP.',
    contact_urls: ['https://cash.app/contact'],
  },

  // ===== Additional credit-card issuers =====

  {
    name: 'Apple Card (Goldman Sachs)',
    category: 'credit_card',
    verified_numbers: ['+18772555923'],
    spoof_message:
      'This IS the real Apple Card line — but scammers frequently spoof it. Apple Card support is also available inside the Wallet app. If unexpected, HANG UP and use the Wallet app.',
    contact_urls: ['https://support.apple.com/apple-card'],
  },
  {
    name: 'Barclays US',
    category: 'credit_card',
    verified_numbers: ['+18775230478'],
    spoof_message:
      'This IS the real Barclays US line — but scammers frequently spoof it. If unexpected, HANG UP and call the number on the back of your card.',
    contact_urls: ['https://cards.barclaycardus.com/banking/contact-us/'],
  },
  {
    name: 'Synchrony Bank',
    category: 'credit_card',
    verified_numbers: ['+18664194096'],
    spoof_message:
      'This IS the real Synchrony line (the bank behind many store cards — Amazon, Lowes, PayPal Credit, CareCredit). If unexpected, HANG UP and call the number on your statement.',
    contact_urls: ['https://www.synchrony.com/contact-us.html'],
  },

  // ===== Crypto exchanges =====

  {
    name: 'Coinbase',
    category: 'crypto_exchange',
    verified_numbers: ['+18889087930'],
    spoof_message:
      'This IS the real Coinbase fraud line — but Coinbase users are the #1 target of impersonation scams. Coinbase will NEVER call to ask you to move funds, share codes, or download remote-access software. HANG UP.',
    contact_urls: ['https://help.coinbase.com/en/contact-us'],
  },
  {
    name: 'Robinhood',
    category: 'crypto_exchange',
    verified_numbers: ['+16509402700'],
    spoof_message:
      'This IS the real Robinhood line — but Robinhood will NEVER call to ask for your password, MFA codes, or to move funds. HANG UP and contact support through the app.',
    contact_urls: ['https://robinhood.com/us/en/support/articles/how-to-contact-support/'],
  },

  // ===== International bank (US operations) =====

  {
    name: 'RBC Bank (US)',
    category: 'bank',
    verified_numbers: ['+18887692551'],
    spoof_message:
      'This IS the real RBC Bank (US) line — but scammers frequently spoof it. If unexpected, HANG UP and call the number on the back of your card.',
    contact_urls: ['https://www.rbcbank.com/cross-border/customer-service.html'],
  },

  // ===== Property & casualty insurance (top US carriers) =====

  {
    name: 'State Farm',
    category: 'insurance',
    verified_numbers: ['+18007828332'],
    spoof_message:
      'This IS the real State Farm line — but policy-renewal and claims scams frequently spoof it. HANG UP and call back using the number on your policy documents or via the Steer Clear app.',
    contact_urls: ['https://www.statefarm.com/customer-care/contact-us'],
  },
  {
    name: 'GEICO',
    category: 'insurance',
    verified_numbers: ['+18008418300', '+18008413000'],
    spoof_message:
      'This IS the real GEICO line — but scammers frequently spoof it. HANG UP and log into the GEICO app to verify any claim or policy issue.',
    contact_urls: ['https://www.geico.com/contact-us/'],
  },
  {
    name: 'Allstate',
    category: 'insurance',
    verified_numbers: ['+18002557828'],
    spoof_message:
      'This IS the real Allstate line — but scammers frequently spoof it in policy-lapse scams. HANG UP and call back using the number on your policy.',
    contact_urls: ['https://www.allstate.com/contact-us'],
  },
  {
    name: 'Progressive',
    category: 'insurance',
    verified_numbers: ['+18007764737'],
    spoof_message:
      'This IS the real Progressive line — but scammers frequently spoof it. HANG UP and log into the Progressive app to verify.',
    contact_urls: ['https://www.progressive.com/contact-us/'],
  },
  {
    name: 'Farmers Insurance',
    category: 'insurance',
    verified_numbers: ['+18883276335'],
    spoof_message:
      'This IS the real Farmers Insurance line — but scammers frequently spoof it. HANG UP and call back using the number on your policy documents.',
    contact_urls: ['https://www.farmers.com/contact-us/'],
  },
  {
    name: 'Liberty Mutual',
    category: 'insurance',
    verified_numbers: ['+18002907933'],
    spoof_message:
      'This IS the real Liberty Mutual line — but scammers frequently spoof it. HANG UP and call back using the number on your policy documents.',
    contact_urls: ['https://www.libertymutual.com/customer-support'],
  },
  {
    name: 'Nationwide',
    category: 'insurance',
    verified_numbers: ['+18776696877'],
    spoof_message:
      'This IS the real Nationwide line — but scammers frequently spoof it. HANG UP and call back using the number on your policy documents.',
    contact_urls: ['https://www.nationwide.com/personal/contact/call-us/'],
  },

  // ===== Health insurance + pharmacy (heavy Medicare-scam vector) =====

  {
    name: 'Aetna',
    category: 'healthcare',
    verified_numbers: ['+18008723862'],
    spoof_message:
      'This IS the real Aetna line — but health-insurance enrollment scams frequently spoof it. Aetna will never ask for your SSN by phone. HANG UP and call back using the number on your insurance card.',
    contact_urls: ['https://www.aetna.com/individuals-families/contact-aetna.html'],
  },
  {
    name: 'UnitedHealthcare',
    category: 'healthcare',
    verified_numbers: ['+18883328648'],
    spoof_message:
      'This IS the real UnitedHealthcare line — but Medicare-enrollment scams heavily spoof this number. UHC will never ask for your SSN or full Medicare number by phone. HANG UP.',
    contact_urls: ['https://www.uhc.com/contact-us'],
  },
  {
    name: 'Humana',
    category: 'healthcare',
    verified_numbers: ['+18004574708'],
    spoof_message:
      'This IS the real Humana line — but Medicare Advantage scams frequently spoof it. HANG UP and call back using the number on your insurance card.',
    contact_urls: ['https://www.humana.com/contact-us'],
  },
  {
    name: 'Cigna',
    category: 'healthcare',
    verified_numbers: ['+18002446224'],
    spoof_message:
      'This IS the real Cigna line — but scammers frequently spoof it. Cigna will never ask for your SSN by phone. HANG UP and call back using the number on your insurance card.',
    contact_urls: ['https://www.cigna.com/contact-us/'],
  },
  {
    name: 'CVS Pharmacy',
    category: 'healthcare',
    verified_numbers: ['+18007467287'],
    spoof_message:
      'This matches a real CVS line. CVS will never call asking for your payment info to "release" a prescription. HANG UP and call your local CVS directly.',
    contact_urls: ['https://www.cvshealth.com/contact.html'],
  },
  {
    name: 'Walgreens',
    category: 'healthcare',
    verified_numbers: ['+18009254733'],
    spoof_message:
      'This matches a real Walgreens line. Walgreens will never call asking for your payment info to "release" a prescription. HANG UP and call your local Walgreens directly.',
    contact_urls: ['https://www.walgreens.com/topic/help/generalhelp.jsp'],
  },

  // ===== Utilities (top US by population served) =====

  {
    name: 'PG&E',
    category: 'utility',
    verified_numbers: ['+18007435000'],
    spoof_message:
      'This IS the real PG&E line — but utility-disconnection scams are rampant in California. PG&E will NEVER demand immediate payment by gift card, crypto, or wire. HANG UP and call 1-800-743-5000.',
    contact_urls: ['https://www.pge.com/en/contact-us.html'],
  },
  {
    name: 'Duke Energy',
    category: 'utility',
    verified_numbers: ['+18007779898'],
    spoof_message:
      'This IS the real Duke Energy line — but utility-disconnection scams are rampant. Duke will NEVER demand immediate payment by gift card, crypto, or wire. HANG UP.',
    contact_urls: ['https://www.duke-energy.com/customer-service/contact-us'],
  },
  {
    name: 'Southern California Edison',
    category: 'utility',
    verified_numbers: ['+18006554555'],
    spoof_message:
      'This IS the real SCE line — but utility-disconnection scams are rampant. SCE will NEVER demand immediate payment by gift card or wire. HANG UP.',
    contact_urls: ['https://www.edison.com/contact-us'],
  },
  {
    name: 'ComEd (Commonwealth Edison)',
    category: 'utility',
    verified_numbers: ['+18003347661'],
    spoof_message:
      'This IS the real ComEd line — but Chicago-area disconnection scams are rampant. ComEd will never demand gift-card payment. HANG UP.',
    contact_urls: ['https://www.comed.com/SitesPages/Contact.aspx'],
  },
  {
    name: 'DTE Energy',
    category: 'utility',
    verified_numbers: ['+18004774747'],
    spoof_message:
      'This IS the real DTE Energy line — but disconnection scams in Michigan are rampant. DTE will never demand gift-card payment. HANG UP.',
    contact_urls: ['https://www.dteenergy.com/us/en/quicklinks/contact-us.html'],
  },
  {
    name: 'National Grid (US)',
    category: 'utility',
    verified_numbers: ['+18006424272'],
    spoof_message:
      'This IS the real National Grid line — but disconnection scams in NY/MA are rampant. National Grid will never demand gift-card payment. HANG UP.',
    contact_urls: ['https://www.nationalgridus.com/help/contact-us'],
  },

  // ===== Cable / ISP (extends telecom; heavy in "internet cancellation" scams) =====

  {
    name: 'Comcast / Xfinity',
    category: 'telecom',
    verified_numbers: ['+18009346489'],
    spoof_message:
      'This IS the real Xfinity line — but "your service is being cancelled" scams heavily spoof it. Xfinity will never ask for gift cards or wire transfers. HANG UP and log into the Xfinity app.',
    contact_urls: ['https://www.xfinity.com/support/contact-us'],
  },
  {
    name: 'Spectrum (Charter)',
    category: 'telecom',
    verified_numbers: ['+18332676094'],
    spoof_message:
      'This IS the real Spectrum line — but billing scams heavily spoof it. HANG UP and log into the Spectrum app.',
    contact_urls: ['https://www.spectrum.com/contact-us'],
  },
  {
    name: 'Cox Communications',
    category: 'telecom',
    verified_numbers: ['+18002343993'],
    spoof_message:
      'This IS the real Cox line — but billing scams heavily spoof it. HANG UP and log into the Cox app to verify.',
    contact_urls: ['https://newsroom.cox.com/contacts'],
  },

  // ===== Airlines (seasonal spike in flight-cancellation scams) =====

  {
    name: 'American Airlines',
    category: 'airline',
    verified_numbers: ['+18004337300'],
    spoof_message:
      'This IS the real American Airlines line — but "your flight was cancelled, give us your card to rebook" scams heavily spoof it. HANG UP and open the American app to verify.',
    contact_urls: ['https://www.aa.com/i18n/customer-service/contact-american/reservations-and-ticket-changes.jsp'],
  },
  {
    name: 'Delta Air Lines',
    category: 'airline',
    verified_numbers: ['+18002211212'],
    spoof_message:
      'This IS the real Delta line — but flight-rebooking scams heavily spoof it. HANG UP and open the Fly Delta app to verify.',
    contact_urls: ['https://www.delta.com/us/en/need-help/overview'],
  },
  {
    name: 'United Airlines',
    category: 'airline',
    verified_numbers: ['+18008648331'],
    spoof_message:
      'This IS the real United line — but flight-rebooking scams heavily spoof it. HANG UP and open the United app to verify.',
    contact_urls: ['https://www.united.com/en/us/customerrelations'],
  },
  {
    name: 'Southwest Airlines',
    category: 'airline',
    verified_numbers: ['+18004359792'],
    spoof_message:
      'This IS the real Southwest line — but flight-rebooking scams heavily spoof it. HANG UP and open the Southwest app to verify.',
    contact_urls: ['https://support.southwest.com/helpcenter/s/article/More-phone-numbers-contact-options'],
  },
  {
    name: 'JetBlue Airways',
    category: 'airline',
    verified_numbers: ['+18005382583'],
    spoof_message:
      'This IS the real JetBlue line (1-800-JETBLUE) — but flight-rebooking scams heavily spoof it. HANG UP and open the JetBlue app to verify.',
    contact_urls: ['https://www.jetblue.com/contact-us'],
  },
  {
    name: 'Alaska Airlines',
    category: 'airline',
    verified_numbers: ['+18002527522', '+18006545669'],
    spoof_message:
      'This IS the real Alaska Airlines line — but flight-rebooking scams heavily spoof it. HANG UP and open the Alaska app to verify.',
    contact_urls: ['https://www.alaskaair.com/content/about-us/help-contact/contact-us'],
  },
  {
    name: 'Spirit Airlines',
    category: 'airline',
    verified_numbers: ['+18557283555'],
    spoof_message:
      'This IS the real Spirit Airlines line — but flight-rebooking scams heavily spoof it. HANG UP and use the Spirit app or spirit.com.',
    contact_urls: ['https://customersupport.spirit.com/en-us/category/article/KA-01219'],
  },
  {
    name: 'Frontier Airlines',
    category: 'airline',
    verified_numbers: ['+16023335925'],
    spoof_message:
      'This IS the real Frontier Airlines line — but flight-rebooking scams heavily spoof it. HANG UP and use flyfrontier.com.',
    contact_urls: ['https://www.flyfrontier.com/customer-service/'],
  },
  {
    name: 'Allegiant Air',
    category: 'airline',
    verified_numbers: ['+17025058888', '+17028002088', '+17024303283'],
    spoof_message:
      'This IS the real Allegiant line — but flight-rebooking scams heavily spoof it. HANG UP and use allegiantair.com.',
    /* contact_urls: intentionally omitted — Akamai bot-block both fetch and Playwright */
  },
  {
    name: 'Hawaiian Airlines',
    category: 'airline',
    verified_numbers: ['+18003675320'],
    spoof_message:
      'This IS the real Hawaiian Airlines line — but flight-rebooking scams heavily spoof it. HANG UP and use hawaiianairlines.com.',
    contact_urls: ['https://www.hawaiianairlines.com/content/contact-us/call'],
  },
  {
    name: 'Sun Country Airlines',
    category: 'airline',
    verified_numbers: ['+16519052737'],
    spoof_message:
      'This IS the real Sun Country line — but flight-rebooking scams heavily spoof it. HANG UP and use suncountry.com.',
    contact_urls: ['https://www.suncountry.com/contact-us'],
  },

  // ===== Additional credit unions (top US by assets, verified 2026-04-17) =====

  {
    name: 'First Tech Federal Credit Union',
    category: 'credit_union',
    verified_numbers: ['+18557448585'],
    spoof_message:
      'This IS the real First Tech FCU line — but scammers spoof tech-employee CUs heavily. First Tech will NEVER ask for your password or MFA code by phone. HANG UP.',
    contact_urls: ['https://www.firsttechfed.com/help/contact'],
  },
  {
    name: 'VyStar Credit Union',
    category: 'credit_union',
    verified_numbers: ['+19047776000', '+18004456289'],
    spoof_message:
      'This IS the real VyStar CU line — but scammers frequently spoof it. VyStar will NEVER ask for your password or full account number by phone. HANG UP.',
    contact_urls: ['https://www.vystarcu.org/contact-us'],
  },
  {
    name: 'Randolph-Brooks Federal Credit Union (RBFCU)',
    category: 'credit_union',
    verified_numbers: [
      '+12109453300', '+18889994355', '+18889994336',
      '+18885562965', '+18005803300',
    ],
    spoof_message:
      'This IS the real RBFCU line — but scammers frequently spoof Texas-area CUs. RBFCU will NEVER ask for your password or MFA code by phone. HANG UP.',
    contact_urls: ['https://www.rbfcu.org/contact'],
  },
  {
    name: 'Suncoast Credit Union',
    category: 'credit_union',
    verified_numbers: ['+18009995887'],
    spoof_message:
      'This IS the real Suncoast CU line — but scammers frequently spoof Florida CUs. Suncoast will NEVER ask for your password by phone. HANG UP.',
    contact_urls: ['https://www.suncoast.com/Contact-Us'],
  },
  {
    name: 'Mountain America Credit Union',
    category: 'credit_union',
    verified_numbers: ['+18007484302'],
    spoof_message:
      'This IS the real Mountain America CU line — but scammers frequently spoof it. MACU will NEVER ask for your password by phone. HANG UP.',
    contact_urls: ['https://www.macu.com/contact-us'],
  },
  {
    name: 'Golden 1 Credit Union',
    category: 'credit_union',
    verified_numbers: ['+18774653361', '+19167322900'],
    spoof_message:
      'This IS the real Golden 1 CU line — but scammers frequently spoof CA CUs. Golden 1 will NEVER ask for your password by phone. HANG UP.',
    contact_urls: ['https://www.golden1.com/contact-us'],
  },
  {
    name: 'Digital Federal Credit Union (DCU)',
    category: 'credit_union',
    verified_numbers: ['+18003288797', '+18008472911'],
    spoof_message:
      'This IS the real DCU line — but scammers frequently spoof it. DCU will NEVER ask for your password by phone. HANG UP and call 1-800-328-8797 directly.',
    contact_urls: ['https://www.dcu.org/contact.html'],
  },
  {
    name: 'Patelco Credit Union',
    category: 'credit_union',
    verified_numbers: ['+18003588228'],
    spoof_message:
      'This IS the real Patelco line — but scammers frequently spoof it. Patelco will NEVER ask for your password by phone. HANG UP.',
    contact_urls: ['https://www.patelco.org/contact-us'],
  },
  {
    name: 'Security Service Federal Credit Union',
    category: 'credit_union',
    verified_numbers: [
      '+18002290158', '+18005277328', '+18663974512', '+18884157878',
    ],
    spoof_message:
      'This IS the real Security Service FCU line — but scammers frequently spoof military-affinity CUs. SSFCU will NEVER ask for your password by phone. HANG UP.',
    contact_urls: ['https://www.ssfcu.org/contact-us'],
  },
  {
    name: 'Wings Financial Credit Union',
    category: 'credit_union',
    verified_numbers: ['+18006922274'],
    spoof_message:
      'This IS the real Wings Financial CU line — but scammers frequently spoof it. Wings will NEVER ask for your password by phone. HANG UP.',
    contact_urls: ['https://www.wingscu.com/contact'],
  },
  {
    name: 'Bethpage Federal Credit Union',
    category: 'credit_union',
    verified_numbers: ['+18006287070'],
    spoof_message:
      'This IS the real Bethpage FCU line — but scammers frequently spoof NY-area CUs. Bethpage will NEVER ask for your password by phone. HANG UP.',
    contact_urls: ['https://www.fourleaffcu.com/contact-and-support/'],
  },
  {
    name: 'Teachers Federal Credit Union',
    category: 'credit_union',
    verified_numbers: ['+18003414333'],
    spoof_message:
      'This IS the real Teachers FCU line — but scammers frequently spoof it. Teachers FCU will NEVER ask for your password by phone. HANG UP.',
    contact_urls: ['https://www.teachersfcu.org/contact-us'],
  },
  {
    name: 'State Employees Credit Union of Maryland (SECU MD)',
    category: 'credit_union',
    verified_numbers: ['+18008797328'],
    spoof_message:
      'This IS the real SECU MD line — but scammers frequently spoof state-employee CUs. SECU MD will NEVER ask for your password by phone. HANG UP.',
    contact_urls: ['https://www.secumd.org/contact-us'],
  },
  {
    name: 'Logix Federal Credit Union',
    category: 'credit_union',
    verified_numbers: ['+18003285328'],
    spoof_message:
      'This IS the real Logix FCU line — but scammers frequently spoof it. Logix will NEVER ask for your password by phone. HANG UP.',
    contact_urls: ['https://www.logixbanking.com/contact-us'],
  },
  {
    name: 'Eastman Credit Union',
    category: 'credit_union',
    verified_numbers: ['+18009992328'],
    spoof_message:
      'This IS the real Eastman CU line — but scammers frequently spoof employer-affinity CUs. Eastman will NEVER ask for your password by phone. HANG UP.',
    contact_urls: ['https://www.ecu.org/contact'],
  },
  {
    name: 'OnPoint Community Credit Union',
    category: 'credit_union',
    verified_numbers: ['+15032287077'],
    spoof_message:
      'This IS the real OnPoint CU line — but scammers frequently spoof OR/WA CUs. OnPoint will NEVER ask for your password by phone. HANG UP.',
    contact_urls: ['https://www.onpointcu.com/contact/'],
  },

  // ===== Additional government (beyond IRS/SSA/Medicare) =====

  {
    name: 'FBI Tip Line',
    category: 'government',
    verified_numbers: ['+18002255324'],
    spoof_message:
      'This IS the real FBI tip line. The FBI will NEVER call demanding payment, threatening arrest, or asking you to wire money. If that is what you are hearing, it is a scam — HANG UP and call 1-800-CALL-FBI directly.',
    contact_urls: ['https://www.fbi.gov/contact-us', 'https://tips.fbi.gov'],
  },
  {
    name: 'FTC Consumer Protection',
    category: 'government',
    verified_numbers: ['+18773824357'],
    spoof_message:
      'This IS the real FTC line. The FTC will NEVER call you asking for payment — they take reports from consumers, not payments. HANG UP and file at reportfraud.ftc.gov.',
    contact_urls: ['https://consumer.ftc.gov/consumer-alerts', 'https://reportfraud.ftc.gov/'],
  },
  {
    name: 'FEMA',
    category: 'government',
    verified_numbers: ['+18006213362'],
    spoof_message:
      'This IS the real FEMA disaster line. FEMA will NEVER charge fees, ask for your bank info over the phone, or demand gift cards. Disaster-relief scams heavily spoof FEMA — HANG UP.',
    contact_urls: ['https://www.fema.gov/about/contact', 'https://www.fema.gov/assistance/individual'],
  },
  {
    name: 'US Department of Veterans Affairs',
    category: 'government',
    verified_numbers: ['+18008271000'],
    spoof_message:
      'This IS the real VA line — but VA-benefits scams are a top phone-scam category targeting veterans. The VA will NEVER ask for your full SSN, bank details, or payment over the phone. HANG UP and call 1-800-827-1000 directly.',
    contact_urls: ['https://department.va.gov/veterans-experience/1-800-myva411/'],
  },

  // ===== Additional regional + specialty banks =====

  {
    name: 'City National Bank',
    category: 'bank',
    verified_numbers: ['+18007737100'],
    spoof_message:
      'This IS the real City National Bank line — but scammers frequently spoof it. If unexpected, HANG UP and call the number on the back of your card.',
    contact_urls: ['https://www.cnb.com/contact-us.html'],
  },
  {
    name: 'Zions Bank',
    category: 'bank',
    verified_numbers: ['+18009748800'],
    spoof_message:
      'This IS the real Zions Bank line — but scammers frequently spoof it. If unexpected, HANG UP and call the number on the back of your card.',
    contact_urls: ['https://www.zionsbank.com/personal/customer-service/'],
  },
  {
    name: 'First Horizon Bank',
    category: 'bank',
    verified_numbers: ['+18003825465'],
    spoof_message:
      'This IS the real First Horizon Bank line — but scammers frequently spoof it. If unexpected, HANG UP and call the number on the back of your card.',
    contact_urls: ['https://www.firsthorizon.com/Personal/Support/Contact-Us'],
  },

  // ===== Brokerages / investment firms (heavy phishing target) =====

  {
    name: 'Fidelity Investments',
    category: 'brokerage',
    verified_numbers: ['+18003433548'],
    spoof_message:
      'This IS the real Fidelity line — but investment-account takeover scams heavily spoof it. Fidelity will NEVER ask you to move funds, share codes, or download remote-access software. HANG UP and log into Fidelity.com.',
    contact_urls: ['https://www.fidelity.com/customer-service/phone-numbers/overview'],
  },
  {
    name: 'Vanguard',
    category: 'brokerage',
    verified_numbers: ['+18776627447'],
    spoof_message:
      'This IS the real Vanguard line — but investment-account takeover scams heavily spoof it. Vanguard will NEVER ask you to move funds or share codes. HANG UP and log into Vanguard.com.',
    contact_urls: ['https://investor.vanguard.com/contact-us/'],
  },
  {
    name: 'T. Rowe Price',
    category: 'brokerage',
    verified_numbers: ['+18002255132'],
    spoof_message:
      'This IS the real T. Rowe Price line — but investment-account takeover scams heavily spoof it. HANG UP and log into troweprice.com.',
    contact_urls: ['https://www.troweprice.com/personal-investing/help/contact-us.html'],
  },
  {
    name: 'E*TRADE (Morgan Stanley)',
    category: 'brokerage',
    verified_numbers: ['+18003872331'],
    spoof_message:
      'This IS the real E*TRADE line — but investment-account scams heavily spoof it. E*TRADE will NEVER ask you to move funds or share MFA codes. HANG UP and log into etrade.com.',
    contact_urls: ['https://us.etrade.com/e/t/estation/help?id=1304000000'],
  },

  // ===== Additional credit unions =====

  {
    name: 'State Employees Credit Union (SECU of NC)',
    category: 'credit_union',
    verified_numbers: ['+18887328562'],
    spoof_message:
      'This IS the real SECU line — but scammers frequently spoof it. SECU will NEVER ask for your password or full account number by phone. HANG UP.',
    contact_urls: ['https://www.ncsecu.org/contact-us'],
  },
  {
    name: 'America First Credit Union',
    category: 'credit_union',
    verified_numbers: ['+18009993961'],
    spoof_message:
      'This IS the real America First CU line — but scammers frequently spoof it. If unexpected, HANG UP and call 1-800-999-3961 directly.',
    contact_urls: ['https://www.americafirst.com/about/contact.html'],
  },
  {
    name: 'SchoolsFirst Federal Credit Union',
    category: 'credit_union',
    verified_numbers: ['+18004628328'],
    spoof_message:
      'This IS the real SchoolsFirst FCU line — but scammers frequently spoof it. If unexpected, HANG UP and call 1-800-462-8328 directly.',
    contact_urls: ['https://www.schoolsfirstfcu.org/contact/get-in-touch/contact-us/'],
  },

  // ===== Additional health insurers =====

  {
    name: 'Kaiser Permanente',
    category: 'healthcare',
    verified_numbers: ['+18004644000'],
    spoof_message:
      'This IS the real Kaiser Permanente member services line — but Medicare-enrollment and prescription scams spoof it. Kaiser will never ask for your SSN or payment by gift card. HANG UP and call the number on your member ID.',
    contact_urls: ['https://healthy.kaiserpermanente.org/support'],
  },
  {
    name: 'Blue Cross Blue Shield Association',
    category: 'healthcare',
    verified_numbers: ['+18886302583'],
    spoof_message:
      'This IS the real BCBS Association line. Your actual Blue Cross plan is state-specific — use the number on your member ID card. Medicare-enrollment scams heavily spoof all Blue plans. HANG UP.',
    contact_urls: ['https://www.bcbs.com/contact-us'],
  },

  // ===== Nonprofits (fake-donation scam vector, especially around disasters) =====

  {
    name: 'American Red Cross',
    category: 'nonprofit',
    verified_numbers: ['+18007332767'],
    spoof_message:
      'This IS the real American Red Cross line — but fake-donation scams after disasters heavily spoof it. The Red Cross will NEVER demand gift cards or wire transfers. Donate directly at redcross.org to be safe.',
    contact_urls: ['https://www.redcross.org/contact-us.html'],
  },
  {
    name: 'The Salvation Army',
    category: 'nonprofit',
    verified_numbers: ['+18007252769'],
    spoof_message:
      'This IS the real Salvation Army line — but fake-donation scams spoof it. The Salvation Army will NEVER demand gift cards or wire transfers. Donate directly at salvationarmyusa.org.',
    contact_urls: ['https://www.salvationarmyusa.org/contact-us/'],
  },
  {
    name: 'Goodwill Industries',
    category: 'nonprofit',
    verified_numbers: ['+18004663945'],
    spoof_message:
      'This IS the real Goodwill line — but donation-pickup scams spoof it. Goodwill will NEVER demand payment. Schedule pickups only through goodwill.org.',
    contact_urls: ['https://www.goodwill.org/contact-us/'],
  },

  // ===== Gig economy: rideshare + food delivery =====

  {
    name: 'Uber',
    category: 'gig_economy',
    verified_numbers: ['+18003538237'],
    spoof_message:
      'This IS the real Uber critical-issues line — but "your driver is calling about a problem" scams heavily spoof it. Uber will NEVER ask you for payment info over the phone. HANG UP and use the in-app help.',
    contact_urls: ['https://www.uber.com/us/en/contact/'],
  },
  {
    name: 'Lyft',
    category: 'gig_economy',
    verified_numbers: ['+18442502773'],
    spoof_message:
      'This IS the real Lyft critical-safety line — but scammers spoof it. Lyft will NEVER ask for your password or card info by phone. HANG UP and use the in-app help.',
    contact_urls: ['https://help.lyft.com/hc/en-us/requests/new'],
  },
  {
    name: 'DoorDash',
    category: 'gig_economy',
    verified_numbers: ['+18559731040'],
    spoof_message:
      'This IS the real DoorDash support line — but "your order has a problem, give us your card" scams spoof it. HANG UP and use the in-app help.',
    contact_urls: ['https://help.doordash.com/consumers/s/'],
  },
  {
    name: 'Grubhub',
    category: 'gig_economy',
    verified_numbers: ['+18775851085'],
    spoof_message:
      'This IS the real Grubhub support line — but order-problem scams spoof it. HANG UP and use the in-app help.',
    contact_urls: ['https://www.grubhub.com/help'],
  },

  // ===== Additional regional + super-regional banks (top 40 US) =====

  {
    name: 'First Citizens Bank',
    category: 'bank',
    verified_numbers: ['+18883234732'],
    spoof_message:
      'This IS the real First Citizens Bank line — but scammers frequently spoof it. If unexpected, HANG UP and call the number on the back of your card.',
    contact_urls: ['https://www.firstcitizens.com/support/call-us'],
  },
  {
    name: 'Valley National Bank',
    category: 'bank',
    verified_numbers: ['+18005224100'],
    spoof_message:
      'This IS the real Valley National line — but scammers frequently spoof it. If unexpected, HANG UP and call the number on the back of your card.',
    contact_urls: ['https://www.valley.com/customer-care/mortgage-help/contact-list'],
  },
  {
    name: 'Webster Bank',
    category: 'bank',
    verified_numbers: ['+18003252424'],
    spoof_message:
      'This IS the real Webster Bank line — but scammers frequently spoof it. If unexpected, HANG UP and call the number on the back of your card.',
    contact_urls: ['https://www.websterbank.com/contact-us/'],
  },
  {
    name: 'Synovus',
    category: 'bank',
    verified_numbers: ['+18887966887'],
    spoof_message:
      'This IS the real Synovus line — but scammers frequently spoof it. If unexpected, HANG UP and call the number on the back of your card.',
    contact_urls: ['https://www.synovus.com/contact-us/'],
  },
  {
    name: 'Fulton Bank',
    category: 'bank',
    verified_numbers: ['+18003858664'],
    spoof_message:
      'This IS the real Fulton Bank line — but scammers frequently spoof it. If unexpected, HANG UP and call the number on the back of your card.',
    contact_urls: ['https://www.fultonbank.com/Customer-Service/Contact-Us'],
  },
  {
    name: 'South State Bank',
    category: 'bank',
    verified_numbers: ['+18002772175'],
    spoof_message:
      'This IS the real South State Bank line — but scammers frequently spoof it. If unexpected, HANG UP and call the number on the back of your card.',
    contact_urls: ['https://www.southstatebank.com/global/help/contact-us'],
  },
  {
    name: 'Flagstar Bank',
    category: 'bank',
    verified_numbers: ['+18882486423'],
    spoof_message:
      'This IS the real Flagstar Bank line — but scammers frequently spoof it. If unexpected, HANG UP and call the number on the back of your card.',
    contact_urls: ['https://www.flagstar.com/contact-us.html'],
  },
  {
    name: 'Prosperity Bank',
    category: 'bank',
    verified_numbers: ['+18005311401'],
    spoof_message:
      'This IS the real Prosperity Bank line — but scammers frequently spoof it. If unexpected, HANG UP and call the number on the back of your card.',
    contact_urls: ['https://www.prosperitybankusa.com/contact-us'],
  },
  {
    name: 'Frost Bank',
    category: 'bank',
    verified_numbers: ['+18005137678'],
    spoof_message:
      'This IS the real Frost Bank line — but scammers frequently spoof TX-area banks. If unexpected, HANG UP and call the number on the back of your card.',
    contact_urls: ['https://www.frostbank.com/support-contact'],
  },
  {
    name: 'East West Bank',
    category: 'bank',
    verified_numbers: ['+18888955650'],
    spoof_message:
      'This IS the real East West Bank line — but scammers frequently spoof it. If unexpected, HANG UP and call the number on the back of your card.',
    contact_urls: ['https://www.eastwestbank.com/en/contact-us'],
  },
  {
    name: 'Western Alliance Bank',
    category: 'bank',
    verified_numbers: ['+18663723932'],
    spoof_message:
      'This IS the real Western Alliance Bank line — but scammers frequently spoof it. If unexpected, HANG UP and call the number on the back of your card.',
    contact_urls: ['https://www.westernalliancebancorporation.com/contact-us'],
  },
  {
    name: 'Old National Bank',
    category: 'bank',
    verified_numbers: ['+18007312265'],
    spoof_message:
      'This IS the real Old National Bank line — but scammers frequently spoof it. If unexpected, HANG UP and call the number on the back of your card.',
    contact_urls: ['https://www.oldnational.com/contact'],
  },
  {
    name: 'Associated Bank',
    category: 'bank',
    verified_numbers: ['+18002368866'],
    spoof_message:
      'This IS the real Associated Bank line — but scammers frequently spoof it. If unexpected, HANG UP and call the number on the back of your card.',
    contact_urls: ['https://www.associatedbank.com/contact'],
  },
  {
    name: 'Cadence Bank',
    category: 'bank',
    verified_numbers: ['+18002388661'],
    spoof_message:
      'This IS the real Cadence Bank line — but scammers frequently spoof it. If unexpected, HANG UP and call the number on the back of your card.',
    contact_urls: ['https://cadencebank.com/contact'],
  },
  {
    name: 'Pinnacle Financial Partners',
    category: 'bank',
    verified_numbers: ['+18002643613'],
    spoof_message:
      'This IS the real Pinnacle line — but scammers frequently spoof it. If unexpected, HANG UP and call the number on the back of your card.',
    contact_urls: ['https://www.pnfp.com/contact-us/'],
  },
  {
    name: 'BankUnited',
    category: 'bank',
    verified_numbers: ['+18777792265'],
    spoof_message:
      'This IS the real BankUnited line — but scammers frequently spoof FL-area banks. If unexpected, HANG UP and call the number on the back of your card.',
    contact_urls: ['https://www.bankunited.com/'],
  },

  // ===== International + additional airlines =====

  {
    name: 'British Airways',
    category: 'airline',
    verified_numbers: ['+18002479297'],
    spoof_message:
      'This IS the real British Airways line — but flight-rebooking scams heavily spoof it. HANG UP and use ba.com or the BA app.',
    contact_urls: ['https://www.britishairways.com/en-us/information/help-and-contacts'],
  },
  {
    name: 'Lufthansa',
    category: 'airline',
    verified_numbers: ['+18006453880'],
    spoof_message:
      'This IS the real Lufthansa line — but flight-rebooking scams heavily spoof it. HANG UP and use lufthansa.com.',
    contact_urls: ['https://www.lufthansa.com/us/en/help-and-contact'],
  },
  {
    name: 'Air Canada',
    category: 'airline',
    verified_numbers: ['+18882472262'],
    spoof_message:
      'This IS the real Air Canada line — but flight-rebooking scams heavily spoof it. HANG UP and use aircanada.com.',
    contact_urls: ['https://www.aircanada.com/us/en/aco/home/fly/customer-support/contact-us.html'],
  },
  {
    name: 'Virgin Atlantic',
    category: 'airline',
    verified_numbers: ['+18008628621'],
    spoof_message:
      'This IS the real Virgin Atlantic line — but flight-rebooking scams heavily spoof it. HANG UP and use virginatlantic.com.',
    contact_urls: ['https://www.virginatlantic.com/en-US/contact-us'],
  },
  {
    name: 'Emirates',
    category: 'airline',
    verified_numbers: ['+18007773999'],
    spoof_message:
      'This IS the real Emirates line — but flight-rebooking scams heavily spoof it. HANG UP and use emirates.com.',
    contact_urls: ['https://www.emirates.com/us/english/help/'],
  },
  {
    name: 'KLM / Air France',
    category: 'airline',
    verified_numbers: ['+18006180104'],
    spoof_message:
      'This IS the real KLM / Air France line — but flight-rebooking scams heavily spoof it. HANG UP and use klm.com or airfrance.com.',
    contact_urls: ['https://www.klm.com/contact'],
  },
  {
    name: 'Qantas',
    category: 'airline',
    verified_numbers: ['+18002274500'],
    spoof_message:
      'This IS the real Qantas line — but flight-rebooking scams heavily spoof it. HANG UP and use qantas.com.',
    contact_urls: ['https://www.qantas.com/us/en/support.html'],
  },
  {
    name: 'Breeze Airways',
    category: 'airline',
    verified_numbers: ['+15012733933'],
    spoof_message:
      'This IS the real Breeze Airways line — but flight-rebooking scams heavily spoof it. HANG UP and use flybreeze.com.',
    contact_urls: ['https://www.flybreeze.com/help'],
  },

  // ===== Additional insurers =====

  {
    name: 'Travelers',
    category: 'insurance',
    verified_numbers: ['+18002524633'],
    spoof_message:
      'This IS the real Travelers line — but policy-renewal and claims scams heavily spoof it. HANG UP and call back using the number on your policy.',
    contact_urls: ['https://www.travelers.com/contact-us'],
  },
  {
    name: 'The Hartford',
    category: 'insurance',
    verified_numbers: ['+18004236789'],
    spoof_message:
      'This IS the real Hartford line — but policy scams heavily spoof it. HANG UP and call back using the number on your policy.',
    contact_urls: ['https://www.thehartford.com/contact-the-hartford'],
  },
  {
    name: 'AIG',
    category: 'insurance',
    verified_numbers: ['+18778673780'],
    spoof_message:
      'This IS the real AIG line — but scammers frequently spoof it. HANG UP and call back using the number on your policy.',
    contact_urls: ['https://www.aig.com/about-us/contact-us'],
  },
  {
    name: 'Chubb',
    category: 'insurance',
    verified_numbers: ['+18002524670'],
    spoof_message:
      'This IS the real Chubb line — but scammers frequently spoof it. HANG UP and call back using the number on your policy.',
    contact_urls: ['https://www.chubb.com/us-en/contact/contact-customer-support.html'],
  },
  {
    name: 'Erie Insurance',
    category: 'insurance',
    verified_numbers: ['+18004580811'],
    spoof_message:
      'This IS the real Erie Insurance line — but scammers frequently spoof it. HANG UP and call back using the number on your policy.',
    contact_urls: ['https://www.erieinsurance.com/contact-erie'],
  },
  {
    name: 'American Family Insurance',
    category: 'insurance',
    verified_numbers: ['+18006926326'],
    spoof_message:
      'This IS the real American Family line — but scammers frequently spoof it. HANG UP and call back using the number on your policy.',
    contact_urls: ['https://www.amfam.com/contact'],
  },
  {
    name: 'Mercury Insurance',
    category: 'insurance',
    verified_numbers: ['+18005033724'],
    spoof_message:
      'This IS the real Mercury Insurance line — but scammers frequently spoof it. HANG UP and call back using the number on your policy.',
    contact_urls: ['https://www.mercuryinsurance.com/contact.html'],
  },
  {
    name: 'AAA (American Automobile Association)',
    category: 'insurance',
    verified_numbers: ['+18002224357'],
    spoof_message:
      'This IS the real AAA roadside line — but scammers frequently spoof it for membership-renewal scams. AAA will NEVER call asking for your card details out of the blue. HANG UP.',
    contact_urls: ['https://www.aaa.com/contact'],
  },

  // ===== All 50 US state tax agencies + DC =====
  // Heavily impersonated: state-tax-impersonation is the #2 tax scam after
  // federal IRS impersonation per state AG complaint reports. Every entry
  // is a department-of-revenue main customer service line (or equivalent).

  {
    name: 'Alabama Department of Revenue',
    category: 'government',
    verified_numbers: ['+13342421170'],
    spoof_message:
      'The Alabama DOR will NEVER demand immediate payment by gift card, wire, or crypto. They communicate primarily by mail. HANG UP.',
    contact_urls: ['https://www.revenue.alabama.gov/contact/'],
  },
  {
    name: 'Alaska Department of Revenue',
    category: 'government',
    verified_numbers: ['+19074652320'],
    spoof_message:
      'Alaska has no state income tax. Any call claiming to collect Alaska state income tax from you is a scam. HANG UP.',
    contact_urls: ['https://tax.alaska.gov/programs/about/contacts.aspx'],
  },
  {
    name: 'Arizona Department of Revenue',
    category: 'government',
    verified_numbers: ['+16022553381'],
    spoof_message:
      'The Arizona DOR will NEVER demand immediate payment by gift card, wire, or crypto. HANG UP.',
    contact_urls: ['https://azdor.gov/contact-us'],
  },
  {
    name: 'Arkansas Department of Finance and Administration',
    category: 'government',
    verified_numbers: ['+15016821100'],
    spoof_message:
      'The Arkansas DFA will NEVER demand immediate payment by gift card, wire, or crypto. HANG UP.',
    contact_urls: ['https://www.dfa.arkansas.gov/contact-info/staff-directory/'],
  },
  {
    name: 'California Franchise Tax Board',
    category: 'government',
    verified_numbers: ['+18008525711'],
    spoof_message:
      'The California FTB will NEVER demand immediate payment by gift card, wire, or crypto. They communicate primarily by mail. HANG UP and call 1-800-852-5711 directly.',
    contact_urls: ['https://www.ftb.ca.gov/help/contact/index.html'],
  },
  {
    name: 'Colorado Department of Revenue',
    category: 'government',
    verified_numbers: ['+13032387378'],
    spoof_message:
      'The Colorado DOR will NEVER demand immediate payment by gift card, wire, or crypto. HANG UP.',
    contact_urls: ['https://tax.colorado.gov/contact-us'],
  },
  {
    name: 'Connecticut Department of Revenue Services',
    category: 'government',
    verified_numbers: ['+18602975962'],
    spoof_message:
      'The CT DRS will NEVER demand immediate payment by gift card, wire, or crypto. HANG UP.',
    contact_urls: ['https://portal.ct.gov/DRS/Contact-DRS/Contact-DRS'],
  },
  {
    name: 'Delaware Division of Revenue',
    category: 'government',
    verified_numbers: ['+13025778200'],
    spoof_message:
      'The Delaware Division of Revenue will NEVER demand immediate payment by gift card, wire, or crypto. HANG UP.',
    contact_urls: ['https://revenue.delaware.gov/contact-information/'],
  },
  {
    name: 'DC Office of Tax and Revenue',
    category: 'government',
    verified_numbers: ['+12027274829'],
    spoof_message:
      'The DC OTR will NEVER demand immediate payment by gift card, wire, or crypto. HANG UP.',
    contact_urls: ['https://otr.cfo.dc.gov/page/contact-otr'],
  },
  {
    name: 'Florida Department of Revenue',
    category: 'government',
    verified_numbers: ['+18504886800'],
    spoof_message:
      'Florida has no state income tax. The FL DOR collects sales/use tax and will NEVER demand immediate payment by gift card, wire, or crypto. HANG UP.',
    contact_urls: ['https://floridarevenue.com/Pages/contact.aspx'],
  },
  {
    name: 'Georgia Department of Revenue',
    category: 'government',
    verified_numbers: ['+18774236711'],
    spoof_message:
      'The Georgia DOR will NEVER demand immediate payment by gift card, wire, or crypto. HANG UP.',
    contact_urls: ['https://dor.georgia.gov/contact-us'],
  },
  {
    name: 'Hawaii Department of Taxation',
    category: 'government',
    verified_numbers: ['+18085874242'],
    spoof_message:
      'The Hawaii Department of Taxation will NEVER demand immediate payment by gift card, wire, or crypto. HANG UP.',
    contact_urls: ['https://tax.hawaii.gov/contact/'],
  },
  {
    name: 'Idaho State Tax Commission',
    category: 'government',
    verified_numbers: ['+12083347660'],
    spoof_message:
      'The Idaho State Tax Commission will NEVER demand immediate payment by gift card, wire, or crypto. HANG UP.',
    contact_urls: ['https://tax.idaho.gov/contact-us/'],
  },
  {
    name: 'Illinois Department of Revenue',
    category: 'government',
    verified_numbers: ['+18007328866'],
    spoof_message:
      'The Illinois DOR will NEVER demand immediate payment by gift card, wire, or crypto. HANG UP.',
    contact_urls: ['https://tax.illinois.gov/aboutidor/contactus.html'],
  },
  {
    name: 'Indiana Department of Revenue',
    category: 'government',
    verified_numbers: ['+13172322240'],
    spoof_message:
      'The Indiana DOR will NEVER demand immediate payment by gift card, wire, or crypto. HANG UP.',
    contact_urls: ['https://www.in.gov/dor/contact-us/'],
  },
  {
    name: 'Iowa Department of Revenue',
    category: 'government',
    verified_numbers: ['+15152813114'],
    spoof_message:
      'The Iowa DOR will NEVER demand immediate payment by gift card, wire, or crypto. HANG UP.',
    contact_urls: ['https://tax.iowa.gov/contact-us'],
  },
  {
    name: 'Kansas Department of Revenue',
    category: 'government',
    verified_numbers: ['+17853688222'],
    spoof_message:
      'The Kansas DOR will NEVER demand immediate payment by gift card, wire, or crypto. HANG UP.',
    contact_urls: ['https://www.ksrevenue.gov/contact.html'],
  },
  {
    name: 'Kentucky Department of Revenue',
    category: 'government',
    verified_numbers: ['+15025644581'],
    spoof_message:
      'The Kentucky DOR will NEVER demand immediate payment by gift card, wire, or crypto. HANG UP.',
    contact_urls: ['https://revenue.ky.gov/Get-Help/Pages/Contact-Us.aspx'],
  },
  {
    name: 'Louisiana Department of Revenue',
    category: 'government',
    verified_numbers: ['+18553073893'],
    spoof_message:
      'The Louisiana DOR will NEVER demand immediate payment by gift card, wire, or crypto. HANG UP.',
    contact_urls: ['https://revenue.louisiana.gov/contact-us/general-resources/contact-info/'],
  },
  {
    name: 'Maine Revenue Services',
    category: 'government',
    verified_numbers: ['+12076249784'],
    spoof_message:
      'Maine Revenue Services will NEVER demand immediate payment by gift card, wire, or crypto. HANG UP.',
    contact_urls: ['https://www.maine.gov/revenue/about/contact'],
  },
  {
    name: 'Maryland Comptroller',
    category: 'government',
    verified_numbers: ['+14102607980'],
    spoof_message:
      'The Maryland Comptroller will NEVER demand immediate payment by gift card, wire, or crypto. HANG UP.',
    contact_urls: ['https://www.marylandcomptroller.gov/about/locations.html'],
  },
  {
    name: 'Massachusetts Department of Revenue',
    category: 'government',
    verified_numbers: ['+16178876367'],
    spoof_message:
      'The Massachusetts DOR will NEVER demand immediate payment by gift card, wire, or crypto. HANG UP.',
    contact_urls: ['https://www.mass.gov/guides/who-to-call-at-dor'],
  },
  {
    name: 'Michigan Department of Treasury',
    category: 'government',
    verified_numbers: ['+15176364486'],
    spoof_message:
      'The Michigan Treasury will NEVER demand immediate payment by gift card, wire, or crypto. HANG UP.',
    contact_urls: ['https://www.michigan.gov/treasury/contact-us'],
  },
  {
    name: 'Minnesota Department of Revenue',
    category: 'government',
    verified_numbers: ['+16512963781'],
    spoof_message:
      'The Minnesota DOR will NEVER demand immediate payment by gift card, wire, or crypto. HANG UP.',
    contact_urls: ['https://www.revenue.state.mn.us/contact-us'],
  },
  {
    name: 'Mississippi Department of Revenue',
    category: 'government',
    verified_numbers: ['+16019237000'],
    spoof_message:
      'The Mississippi DOR will NEVER demand immediate payment by gift card, wire, or crypto. HANG UP.',
    contact_urls: ['https://www.dor.ms.gov/contact-us'],
  },
  {
    name: 'Missouri Department of Revenue',
    category: 'government',
    verified_numbers: ['+15737513505'],
    spoof_message:
      'The Missouri DOR will NEVER demand immediate payment by gift card, wire, or crypto. HANG UP.',
    contact_urls: ['https://dor.mo.gov/contact/'],
  },
  {
    name: 'Montana Department of Revenue',
    category: 'government',
    verified_numbers: ['+14064446900'],
    spoof_message:
      'The Montana DOR will NEVER demand immediate payment by gift card, wire, or crypto. HANG UP.',
    contact_urls: ['https://mtrevenue.gov/contact/'],
  },
  {
    name: 'Nebraska Department of Revenue',
    category: 'government',
    verified_numbers: ['+18007427474'],
    spoof_message:
      'The Nebraska DOR will NEVER demand immediate payment by gift card, wire, or crypto. HANG UP.',
    contact_urls: ['https://revenue.nebraska.gov/about/contact-us'],
  },
  {
    name: 'Nevada Department of Taxation',
    category: 'government',
    verified_numbers: ['+18669623707'],
    spoof_message:
      'Nevada has no state income tax. Any call claiming to collect Nevada state income tax is a scam. HANG UP.',
    contact_urls: ['https://tax.nv.gov/Contact/Contact/'],
  },
  {
    name: 'New Hampshire Department of Revenue Administration',
    category: 'government',
    verified_numbers: ['+16032305000'],
    spoof_message:
      'NH has very limited state income tax (interest/dividends only). The NH DRA will NEVER demand immediate payment by gift card, wire, or crypto. HANG UP.',
    contact_urls: ['https://www.revenue.nh.gov/contact-us'],
  },
  {
    name: 'New Jersey Division of Taxation',
    category: 'government',
    verified_numbers: ['+16092926400'],
    spoof_message:
      'The NJ Division of Taxation will NEVER demand immediate payment by gift card, wire, or crypto. HANG UP.',
    contact_urls: ['https://www.state.nj.us/treasury/taxation/contact.shtml'],
  },
  {
    name: 'New Mexico Taxation and Revenue',
    category: 'government',
    verified_numbers: ['+18662852996'],
    spoof_message:
      'The NM TRD will NEVER demand immediate payment by gift card, wire, or crypto. HANG UP.',
    contact_urls: ['https://www.tax.newmexico.gov/contact-us/'],
  },
  {
    name: 'New York State Department of Taxation and Finance',
    category: 'government',
    verified_numbers: ['+15184575181'],
    spoof_message:
      'The NY State Department of Taxation will NEVER demand immediate payment by gift card, wire, or crypto. They communicate primarily by mail. HANG UP.',
    contact_urls: ['https://www.tax.ny.gov/help/contact/default.htm'],
  },
  {
    name: 'North Carolina Department of Revenue',
    category: 'government',
    verified_numbers: ['+18772523052'],
    spoof_message:
      'The NC DOR will NEVER demand immediate payment by gift card, wire, or crypto. HANG UP.',
    contact_urls: ['https://www.ncdor.gov/contact-ncdor'],
  },
  {
    name: 'North Dakota Office of State Tax Commissioner',
    category: 'government',
    verified_numbers: ['+17013287088'],
    spoof_message:
      'The ND Tax Commissioner will NEVER demand immediate payment by gift card, wire, or crypto. HANG UP.',
    contact_urls: ['https://www.tax.nd.gov/about/contact-us'],
  },
  {
    name: 'Ohio Department of Taxation',
    category: 'government',
    verified_numbers: ['+18002821780'],
    spoof_message:
      'The Ohio Department of Taxation will NEVER demand immediate payment by gift card, wire, or crypto. HANG UP.',
    contact_urls: ['https://tax.ohio.gov/help-center/contact-us'],
  },
  {
    name: 'Oklahoma Tax Commission',
    category: 'government',
    verified_numbers: ['+14055213160'],
    spoof_message:
      'The Oklahoma Tax Commission will NEVER demand immediate payment by gift card, wire, or crypto. HANG UP.',
    contact_urls: ['https://oklahoma.gov/tax/contact.html'],
  },
  {
    name: 'Oregon Department of Revenue',
    category: 'government',
    verified_numbers: ['+15033784988'],
    spoof_message:
      'The Oregon DOR will NEVER demand immediate payment by gift card, wire, or crypto. HANG UP.',
    contact_urls: ['https://www.oregon.gov/dor/contact/pages/default.aspx'],
  },
  {
    name: 'Pennsylvania Department of Revenue',
    category: 'government',
    verified_numbers: ['+17177871064'],
    spoof_message:
      'The PA DOR will NEVER demand immediate payment by gift card, wire, or crypto. HANG UP.',
    contact_urls: ['https://www.revenue.pa.gov/ContactUs/Pages/default.aspx'],
  },
  {
    name: 'Rhode Island Division of Taxation',
    category: 'government',
    verified_numbers: ['+14015748829'],
    spoof_message:
      'The RI Division of Taxation will NEVER demand immediate payment by gift card, wire, or crypto. HANG UP.',
    contact_urls: ['https://tax.ri.gov/about-us/contact-us'],
  },
  {
    name: 'South Carolina Department of Revenue',
    category: 'government',
    verified_numbers: ['+18038985000'],
    spoof_message:
      'The SC DOR will NEVER demand immediate payment by gift card, wire, or crypto. HANG UP.',
    contact_urls: ['https://dor.sc.gov/contact'],
  },
  {
    name: 'South Dakota Department of Revenue',
    category: 'government',
    verified_numbers: ['+16057733311'],
    spoof_message:
      'SD has no state income tax. Any call claiming to collect SD state income tax is a scam. HANG UP.',
    contact_urls: ['https://dor.sd.gov/contact/'],
  },
  {
    name: 'Tennessee Department of Revenue',
    category: 'government',
    verified_numbers: ['+16152530600'],
    spoof_message:
      'The Tennessee DOR will NEVER demand immediate payment by gift card, wire, or crypto. HANG UP.',
    contact_urls: ['https://www.tn.gov/revenue.html'],
  },
  {
    name: 'Texas Comptroller of Public Accounts',
    category: 'government',
    verified_numbers: ['+18005315441', '+18002525555', '+18883344112'],
    spoof_message:
      'Texas has no state income tax. The Texas Comptroller collects sales/franchise tax and will NEVER demand immediate payment by gift card, wire, or crypto. HANG UP.',
    contact_urls: ['https://comptroller.texas.gov/about/contact/'],
  },
  {
    name: 'Utah State Tax Commission',
    category: 'government',
    verified_numbers: ['+18012972200'],
    spoof_message:
      'The Utah State Tax Commission will NEVER demand immediate payment by gift card, wire, or crypto. HANG UP.',
    contact_urls: ['https://tax.utah.gov/contact'],
  },
  {
    name: 'Vermont Department of Taxes',
    category: 'government',
    verified_numbers: ['+18028282865'],
    spoof_message:
      'The Vermont Department of Taxes will NEVER demand immediate payment by gift card, wire, or crypto. HANG UP.',
    contact_urls: ['https://tax.vermont.gov/contact'],
  },
  {
    name: 'Virginia Department of Taxation',
    category: 'government',
    verified_numbers: ['+18043678031'],
    spoof_message:
      'The Virginia Department of Taxation will NEVER demand immediate payment by gift card, wire, or crypto. HANG UP.',
    contact_urls: ['https://www.tax.virginia.gov/contact-us'],
  },
  {
    name: 'Washington Department of Revenue',
    category: 'government',
    verified_numbers: ['+18006477706'],
    spoof_message:
      'WA has no state income tax. The WA DOR collects B&O/sales tax and will NEVER demand immediate payment by gift card, wire, or crypto. HANG UP.',
    contact_urls: ['https://dor.wa.gov/contact-us'],
  },
  {
    name: 'West Virginia Tax Division',
    category: 'government',
    verified_numbers: ['+13045583333'],
    spoof_message:
      'The WV Tax Division will NEVER demand immediate payment by gift card, wire, or crypto. HANG UP.',
    contact_urls: ['https://tax.wv.gov/About/Contact/Pages/ContactUs.aspx'],
  },
  {
    name: 'Wisconsin Department of Revenue',
    category: 'government',
    verified_numbers: ['+16082662486'],
    spoof_message:
      'The Wisconsin DOR will NEVER demand immediate payment by gift card, wire, or crypto. HANG UP.',
    contact_urls: ['https://www.revenue.wi.gov/Pages/ContactUs/home.aspx'],
  },
  {
    name: 'Wyoming Department of Revenue',
    category: 'government',
    verified_numbers: ['+13077775275'],
    spoof_message:
      'Wyoming has no state income tax. Any call claiming to collect WY state income tax is a scam. HANG UP.',
    contact_urls: ['https://wyo-prop-div.wyo.gov/contacts/dor-contacts'],
  },

  // ===== All 50 state DMVs / vehicle agencies =====
  // DMV impersonation ("your vehicle registration is suspended, pay now")
  // is a top 5 scam category per FTC consumer data. Every entry is the main
  // customer service line for the state's vehicle-licensing authority.

  { name: 'Alabama Law Enforcement Agency / Driver License', category: 'government', verified_numbers: ['+13342424400'], spoof_message: 'The AL driver license division will NEVER demand immediate payment by phone, gift card, or wire. HANG UP.' , contact_urls: ['https://www.alea.gov/contact-alea'], },
  { name: 'Alaska DMV', category: 'government', verified_numbers: ['+19072695551'], spoof_message: 'The Alaska DMV will NEVER demand immediate payment by phone, gift card, or wire. HANG UP.' , contact_urls: ['https://dmv.alaska.gov/contact-us/'], },
  { name: 'Arizona MVD (ADOT)', category: 'government', verified_numbers: ['+16022550072'], spoof_message: 'The Arizona MVD will NEVER demand immediate payment by phone, gift card, or wire. HANG UP.' , contact_urls: ['https://azdot.gov/mvd/contact-mvd'], },
  { name: 'Arkansas DMV (DFA)', category: 'government', verified_numbers: ['+15016824692'], spoof_message: 'The Arkansas DMV will NEVER demand immediate payment by phone, gift card, or wire. HANG UP.' , contact_urls: ['https://www.dfa.arkansas.gov/office/motor-vehicle/'], },
  { name: 'California DMV', category: 'government', verified_numbers: ['+18007770133'], spoof_message: 'The California DMV will NEVER demand immediate payment by phone, gift card, or wire. HANG UP and call 1-800-777-0133 directly.' , contact_urls: ['https://www.dmv.ca.gov/portal/contacting-dmv/'], },
  { name: 'Colorado DMV', category: 'government', verified_numbers: ['+13032055600'], spoof_message: 'The Colorado DMV will NEVER demand immediate payment by phone, gift card, or wire. HANG UP.' , contact_urls: ['https://dmv.colorado.gov/contact-us-dmv'], },
  { name: 'Connecticut DMV', category: 'government', verified_numbers: ['+18602635700'], spoof_message: 'The Connecticut DMV will NEVER demand immediate payment by phone, gift card, or wire. HANG UP.' , contact_urls: ['https://portal.ct.gov/dmv/resources/dmv-contact-us'], },
  { name: 'Delaware DMV', category: 'government', verified_numbers: ['+13027442500'], spoof_message: 'The Delaware DMV will NEVER demand immediate payment by phone, gift card, or wire. HANG UP.' , contact_urls: ['https://www.dmv.de.gov/About/contact_info/index.shtml'], },
  { name: 'Florida DHSMV', category: 'government', verified_numbers: ['+18506172000'], spoof_message: 'The Florida DHSMV will NEVER demand immediate payment by phone, gift card, or wire. HANG UP.' , contact_urls: ['https://www.flhsmv.gov/contact-us/'], },
  { name: 'Georgia Driver Services', category: 'government', verified_numbers: ['+16784138400'], spoof_message: 'Georgia Driver Services will NEVER demand immediate payment by phone, gift card, or wire. HANG UP.' , contact_urls: ['https://dds.georgia.gov/contact-us'], },
  { name: 'Hawaii DOT Motor Vehicles', category: 'government', verified_numbers: ['+18085873111'], spoof_message: 'Hawaii DOT Motor Vehicles will NEVER demand immediate payment by phone, gift card, or wire. HANG UP.' , contact_urls: ['https://hidot.hawaii.gov/highways/home/motor-vehicle-safety-office/'], },
  { name: 'Idaho Transportation Department / DMV', category: 'government', verified_numbers: ['+12083348000'], spoof_message: 'The Idaho ITD/DMV will NEVER demand immediate payment by phone, gift card, or wire. HANG UP.' , contact_urls: ['https://itd.idaho.gov/itddmv/'], },
  { name: 'Illinois Secretary of State DMV', category: 'government', verified_numbers: ['+18002528980'], spoof_message: 'The Illinois SOS DMV will NEVER demand immediate payment by phone, gift card, or wire. HANG UP.' , contact_urls: ['https://www.ilsos.gov/departments/drivers/home.html'], },
  { name: 'Indiana BMV', category: 'government', verified_numbers: ['+18886926841'], spoof_message: 'The Indiana BMV will NEVER demand immediate payment by phone, gift card, or wire. HANG UP.' , contact_urls: ['https://www.in.gov/bmv/contact/'], },
  { name: 'Iowa DOT', category: 'government', verified_numbers: ['+15152448725'], spoof_message: 'The Iowa DOT will NEVER demand immediate payment by phone, gift card, or wire. HANG UP.' , contact_urls: ['https://iowadot.gov/contact'], },
  { name: 'Kansas Division of Vehicles', category: 'government', verified_numbers: ['+17852963621'], spoof_message: 'The Kansas Division of Vehicles will NEVER demand immediate payment by phone, gift card, or wire. HANG UP.' , contact_urls: ['https://www.ksrevenue.gov/dovcontact.html'], },
  { name: 'Kentucky Transportation Cabinet / DMV', category: 'government', verified_numbers: ['+15025641257'], spoof_message: 'The Kentucky Transportation Cabinet DMV will NEVER demand immediate payment by phone, gift card, or wire. HANG UP.' , contact_urls: ['https://drive.ky.gov/Pages/Contact-Us.aspx'], },
  { name: 'Louisiana OMV', category: 'government', verified_numbers: ['+18773685463'], spoof_message: 'The Louisiana OMV will NEVER demand immediate payment by phone, gift card, or wire. HANG UP.' , contact_urls: ['https://www.expresslane.org/contact-us/'], },
  { name: 'Maine BMV', category: 'government', verified_numbers: ['+12076249000'], spoof_message: 'The Maine BMV will NEVER demand immediate payment by phone, gift card, or wire. HANG UP.' , contact_urls: ['https://www.maine.gov/sos/about-us/contact-us'], },
  { name: 'Maryland MVA', category: 'government', verified_numbers: ['+14107687000'], spoof_message: 'The Maryland MVA will NEVER demand immediate payment by phone, gift card, or wire. HANG UP.' , contact_urls: ['https://mva.maryland.gov/Pages/default.aspx'], },
  { name: 'Massachusetts RMV', category: 'government', verified_numbers: ['+18573688000'], spoof_message: 'The Massachusetts RMV will NEVER demand immediate payment by phone, gift card, or wire. HANG UP.' , contact_urls: ['https://www.mass.gov/info-details/ask-the-rmv'], },
  { name: 'Michigan Secretary of State', category: 'government', verified_numbers: ['+18887676424'], spoof_message: 'The Michigan SOS will NEVER demand immediate payment by phone, gift card, or wire. HANG UP.' , contact_urls: ['https://www.michigan.gov/sos/mdos-directory'], },
  { name: 'Minnesota DPS Driver and Vehicle Services', category: 'government', verified_numbers: ['+16512972126'], spoof_message: 'MN DVS will NEVER demand immediate payment by phone, gift card, or wire. HANG UP.' , contact_urls: ['https://dps.mn.gov/divisions/dvs/contact'], },
  { name: 'Mississippi DPS Driver Services', category: 'government', verified_numbers: ['+16019871248'], spoof_message: 'MS DPS Driver Services will NEVER demand immediate payment by phone, gift card, or wire. HANG UP.' , contact_urls: ['https://www.driverservicebureau.dps.ms.gov/Contact'], },
  { name: 'Missouri Motor Vehicle Bureau', category: 'government', verified_numbers: ['+15735263669'], spoof_message: 'The MO MVB will NEVER demand immediate payment by phone, gift card, or wire. HANG UP.' , contact_urls: ['https://dor.mo.gov/contact/motor-vehicle.html'], },
  { name: 'Montana Motor Vehicle Division', category: 'government', verified_numbers: ['+14064443933'], spoof_message: 'The Montana MVD will NEVER demand immediate payment by phone, gift card, or wire. HANG UP.' , contact_urls: ['https://mvdmt.gov/contact-us/'], },
  { name: 'Nebraska DMV', category: 'government', verified_numbers: ['+14024713861'], spoof_message: 'The Nebraska DMV will NEVER demand immediate payment by phone, gift card, or wire. HANG UP.' , contact_urls: ['https://dmv.nebraska.gov/contact'], },
  { name: 'Nevada DMV', category: 'government', verified_numbers: ['+18773687828'], spoof_message: 'The Nevada DMV will NEVER demand immediate payment by phone, gift card, or wire. HANG UP.' , contact_urls: ['https://dmv.nv.gov/contact.htm'], },
  { name: 'New Hampshire DMV', category: 'government', verified_numbers: ['+16032274000'], spoof_message: 'The NH DMV will NEVER demand immediate payment by phone, gift card, or wire. HANG UP.' , contact_urls: ['https://www.dmv.nh.gov/contact-us'], },
  { name: 'New Jersey MVC', category: 'government', verified_numbers: ['+16092926500'], spoof_message: 'The NJ MVC will NEVER demand immediate payment by phone, gift card, or wire. HANG UP.' , contact_urls: ['https://www.state.nj.us/mvc/about/contact.htm'], },
  { name: 'New Mexico MVD', category: 'government', verified_numbers: ['+18886834636'], spoof_message: 'The NM MVD will NEVER demand immediate payment by phone, gift card, or wire. HANG UP.' , contact_urls: ['https://www.mvd.newmexico.gov/contact-us/'], },
  { name: 'New York DMV', category: 'government', verified_numbers: ['+15184869786'], spoof_message: 'The NY DMV will NEVER demand immediate payment by phone, gift card, or wire. HANG UP.' , contact_urls: ['https://dmv.ny.gov/contact-us/dmv-phone-numbers'], },
  { name: 'North Carolina DMV', category: 'government', verified_numbers: ['+19197157000'], spoof_message: 'The NC DMV will NEVER demand immediate payment by phone, gift card, or wire. HANG UP.' , contact_urls: ['https://www.ncdot.gov/dmv/Pages/default.aspx'], },
  { name: 'North Dakota DOT', category: 'government', verified_numbers: ['+18556336835'], spoof_message: 'The ND DOT will NEVER demand immediate payment by phone, gift card, or wire. HANG UP.' , contact_urls: ['https://www.dot.nd.gov/contact-us'], },
  { name: 'Ohio BMV', category: 'government', verified_numbers: ['+18446446268'], spoof_message: 'The Ohio BMV will NEVER demand immediate payment by phone, gift card, or wire. HANG UP.' , contact_urls: ['https://bmv.ohio.gov/about-contact.aspx'], },
  { name: 'Oklahoma DPS', category: 'government', verified_numbers: ['+14054252424'], spoof_message: 'The Oklahoma DPS will NEVER demand immediate payment by phone, gift card, or wire. HANG UP.' , contact_urls: ['https://oklahoma.gov/dps/about.html'], },
  { name: 'Oregon DMV', category: 'government', verified_numbers: ['+15039455000'], spoof_message: 'The Oregon DMV will NEVER demand immediate payment by phone, gift card, or wire. HANG UP.' , contact_urls: ['https://www.oregon.gov/odot/DMV/Pages/Contact_Us.aspx'], },
  { name: 'Pennsylvania PennDOT', category: 'government', verified_numbers: ['+18009324600'], spoof_message: 'PennDOT will NEVER demand immediate payment by phone, gift card, or wire. HANG UP.' , contact_urls: ['https://www.penndot.pa.gov/Pages/Contact-Us.aspx'], },
  { name: 'Rhode Island DMV', category: 'government', verified_numbers: ['+14014624368'], spoof_message: 'The RI DMV will NEVER demand immediate payment by phone, gift card, or wire. HANG UP.' , contact_urls: ['https://dmv.ri.gov/contact'], },
  { name: 'South Carolina DMV', category: 'government', verified_numbers: ['+18038965000'], spoof_message: 'The SC DMV will NEVER demand immediate payment by phone, gift card, or wire. HANG UP.' , contact_urls: ['https://www.scdmvonline.com/About'], },
  { name: 'South Dakota DMV', category: 'government', verified_numbers: ['+16057736883'], spoof_message: 'The SD DMV will NEVER demand immediate payment by phone, gift card, or wire. HANG UP.' , contact_urls: ['https://dor.sd.gov/individuals/motor-vehicle/'], },
  { name: 'Tennessee Driver Services', category: 'government', verified_numbers: ['+16157413954'], spoof_message: 'TN Driver Services will NEVER demand immediate payment by phone, gift card, or wire. HANG UP.' , /* contact_urls: intentionally omitted — tn.gov connection-resets our IP */ },
  { name: 'Texas DMV', category: 'government', verified_numbers: ['+18883684689'], spoof_message: 'The Texas DMV will NEVER demand immediate payment by phone, gift card, or wire. HANG UP.' , contact_urls: ['https://www.txdmv.gov/contact-us'], },
  { name: 'Utah DMV', category: 'government', verified_numbers: ['+18012977780'], spoof_message: 'The Utah DMV will NEVER demand immediate payment by phone, gift card, or wire. HANG UP.' , contact_urls: ['https://dmv.utah.gov/contact'], },
  { name: 'Vermont DMV', category: 'government', verified_numbers: ['+18028282000'], spoof_message: 'The Vermont DMV will NEVER demand immediate payment by phone, gift card, or wire. HANG UP.' , contact_urls: ['https://dmv.vermont.gov/contact'], },
  { name: 'Virginia DMV', category: 'government', verified_numbers: ['+18044977100'], spoof_message: 'The Virginia DMV will NEVER demand immediate payment by phone, gift card, or wire. HANG UP.' , contact_urls: ['https://www.dmv.virginia.gov/contact-us'], },
  { name: 'Washington Department of Licensing', category: 'government', verified_numbers: ['+13609023770'], spoof_message: 'The WA DOL will NEVER demand immediate payment by phone, gift card, or wire. HANG UP.' , contact_urls: ['https://dol.wa.gov/about/contact-us'], },
  { name: 'West Virginia DMV', category: 'government', verified_numbers: ['+18006429066'], spoof_message: 'The WV DMV will NEVER demand immediate payment by phone, gift card, or wire. HANG UP.' , contact_urls: ['https://transportation.wv.gov/DMV/About/Pages/Contact-Us.aspx'], },
  { name: 'Wisconsin DMV', category: 'government', verified_numbers: ['+16082647447'], spoof_message: 'The Wisconsin DMV will NEVER demand immediate payment by phone, gift card, or wire. HANG UP.' , contact_urls: ['https://wisconsindot.gov/Pages/about-wisdot/contact-us/dmv-contact.aspx'], },
  { name: 'Wyoming DOT', category: 'government', verified_numbers: ['+13077774375'], spoof_message: 'The Wyoming DOT will NEVER demand immediate payment by phone, gift card, or wire. HANG UP.' , contact_urls: ['https://www.dot.state.wy.us/home/driver_license_records/contact-dri.html'], },

  // ===== All 50 state unemployment / workforce agencies =====
  // Massive COVID-era scam vector that still hasn't cooled. Every entry is
  // the state UI/workforce agency main customer service line.

  { name: 'Alabama Department of Labor', category: 'government', verified_numbers: ['+18003614524'], spoof_message: 'The AL DOL will NEVER ask for your password, PIN, or SSN by phone. File unemployment only at the official state site. HANG UP.' , contact_urls: ['https://labor.alabama.gov/uc/phone.aspx'], },
  { name: 'Alaska Department of Labor', category: 'government', verified_numbers: ['+18884482937'], spoof_message: 'The AK DOL will NEVER ask for your password, PIN, or SSN by phone. HANG UP.' , contact_urls: ['https://labor.alaska.gov/lss/contacts.htm'], },
  { name: 'Arizona DES (Unemployment)', category: 'government', verified_numbers: ['+18776002722'], spoof_message: 'Arizona DES will NEVER ask for your password, PIN, or SSN by phone. HANG UP.' , contact_urls: ['https://des.az.gov/contact-us'], },
  { name: 'Arkansas Division of Workforce Services', category: 'government', verified_numbers: ['+15016822121'], spoof_message: 'Arkansas DWS will NEVER ask for your password, PIN, or SSN by phone. HANG UP.' , contact_urls: ['https://dws.arkansas.gov/workforce-services/contact/'], },
  { name: 'California EDD (Unemployment)', category: 'government', verified_numbers: ['+18003005616'], spoof_message: 'California EDD will NEVER ask for your password, PIN, or SSN by phone. HANG UP and call 1-800-300-5616 directly.' , contact_urls: ['https://edd.ca.gov/en/about_edd/contact_edd/'], },
  { name: 'Colorado Department of Labor and Employment', category: 'government', verified_numbers: ['+13033189000'], spoof_message: 'Colorado DOL will NEVER ask for your password, PIN, or SSN by phone. HANG UP.' , contact_urls: ['https://cdle.colorado.gov/contact-us'], },
  { name: 'Connecticut Department of Labor', category: 'government', verified_numbers: ['+18003543305'], spoof_message: 'The CT DOL will NEVER ask for your password, PIN, or SSN by phone. HANG UP.' , contact_urls: ['https://www.ctdol.state.ct.us/contact.htm'], },
  { name: 'Delaware Department of Labor', category: 'government', verified_numbers: ['+18007943032'], spoof_message: 'The DE DOL will NEVER ask for your password, PIN, or SSN by phone. HANG UP.' , contact_urls: ['https://labor.delaware.gov/contact-us/'], },
  { name: 'DC Department of Employment Services', category: 'government', verified_numbers: ['+12027247000'], spoof_message: 'DC DOES will NEVER ask for your password, PIN, or SSN by phone. HANG UP.' , contact_urls: ['https://does.dc.gov/'], },
  { name: 'Florida Department of Economic Opportunity', category: 'government', verified_numbers: ['+18002042418'], spoof_message: 'Florida DEO will NEVER ask for your password, PIN, or SSN by phone. HANG UP.' , contact_urls: ['https://floridajobs.org/help-center---contact-us'], },
  { name: 'Georgia Department of Labor', category: 'government', verified_numbers: ['+18777098185'], spoof_message: 'Georgia DOL will NEVER ask for your password, PIN, or SSN by phone. HANG UP.' , contact_urls: ['https://dol.georgia.gov/contact-us'], },
  { name: 'Hawaii Department of Labor and Industrial Relations', category: 'government', verified_numbers: ['+18085868970'], spoof_message: 'Hawaii DLIR will NEVER ask for your password, PIN, or SSN by phone. HANG UP.' , contact_urls: ['https://labor.hawaii.gov/contact/'], },
  { name: 'Idaho Department of Labor', category: 'government', verified_numbers: ['+12083328942'], spoof_message: 'Idaho Labor will NEVER ask for your password, PIN, or SSN by phone. HANG UP.' , contact_urls: ['https://www.labor.idaho.gov/dnn/Contact-Us'], },
  { name: 'Illinois IDES (Unemployment)', category: 'government', verified_numbers: ['+18002445631'], spoof_message: 'Illinois IDES will NEVER ask for your password, PIN, or SSN by phone. HANG UP.' , contact_urls: ['https://ides.illinois.gov/about/contact-ides.html'], },
  { name: 'Indiana Department of Workforce Development', category: 'government', verified_numbers: ['+18008916499'], spoof_message: 'Indiana DWD will NEVER ask for your password, PIN, or SSN by phone. HANG UP.' , contact_urls: ['https://www.in.gov/dwd/contact-us/'], },
  { name: 'Iowa Workforce Development', category: 'government', verified_numbers: ['+18662390843'], spoof_message: 'Iowa Workforce will NEVER ask for your password, PIN, or SSN by phone. HANG UP.' , contact_urls: ['https://workforce.iowa.gov/contact'], },
  { name: 'Kansas Department of Labor', category: 'government', verified_numbers: ['+18002926333'], spoof_message: 'Kansas DOL will NEVER ask for your password, PIN, or SSN by phone. HANG UP.' , contact_urls: ['https://www.dol.ks.gov/labor-market-information/contact-us'], },
  { name: 'Kentucky Office of Unemployment Insurance', category: 'government', verified_numbers: ['+15028750442'], spoof_message: 'KY OUI will NEVER ask for your password, PIN, or SSN by phone. HANG UP.' , /* contact_urls: intentionally omitted — site returns 404 / 503 intermittently */ },
  { name: 'Louisiana Workforce Commission', category: 'government', verified_numbers: ['+18667835567'], spoof_message: 'Louisiana LWC will NEVER ask for your password, PIN, or SSN by phone. HANG UP.' , contact_urls: ['https://www.laworks.net/PublicRelations/PR_Contacts.asp'], },
  { name: 'Maine Department of Labor', category: 'government', verified_numbers: ['+18005937660'], spoof_message: 'Maine DOL will NEVER ask for your password, PIN, or SSN by phone. HANG UP.' , contact_urls: ['https://www.maine.gov/labor/contact/index.shtml'], },
  { name: 'Maryland Department of Labor', category: 'government', verified_numbers: ['+14107672100'], spoof_message: 'Maryland DOL will NEVER ask for your password, PIN, or SSN by phone. HANG UP.' , contact_urls: ['https://www.labor.maryland.gov/contactinfo/'], },
  { name: 'Massachusetts DUA (Unemployment)', category: 'government', verified_numbers: ['+18776266800'], spoof_message: 'MA DUA will NEVER ask for your password, PIN, or SSN by phone. HANG UP.' , contact_urls: ['https://www.mass.gov/info-details/department-of-unemployment-assistance-dua-contact-information'], },
  { name: 'Michigan UIA', category: 'government', verified_numbers: ['+18665000017'], spoof_message: 'Michigan UIA will NEVER ask for your password, PIN, or SSN by phone. HANG UP.' , contact_urls: ['https://www.michigan.gov/leo/bureaus-agencies/uia/contact'], },
  { name: 'Minnesota Unemployment Insurance', category: 'government', verified_numbers: ['+16512963644'], spoof_message: 'MN UI will NEVER ask for your password, PIN, or SSN by phone. HANG UP.' , contact_urls: ['https://www.uimn.org/applicants/contact-us/'], },
  { name: 'Mississippi Department of Employment Security', category: 'government', verified_numbers: ['+18888443577'], spoof_message: 'MS MDES will NEVER ask for your password, PIN, or SSN by phone. HANG UP.' , contact_urls: ['https://mdes.ms.gov/information-center/about-mdes/contact-us/'], },
  { name: 'Missouri Department of Labor', category: 'government', verified_numbers: ['+18003202519'], spoof_message: 'Missouri DOLIR will NEVER ask for your password, PIN, or SSN by phone. HANG UP.' , contact_urls: ['https://labor.mo.gov/contact'], },
  { name: 'Montana Unemployment Insurance', category: 'government', verified_numbers: ['+14064442545'], spoof_message: 'Montana UI will NEVER ask for your password, PIN, or SSN by phone. HANG UP.' , contact_urls: ['https://uid.dli.mt.gov/claimants/contact'], },
  { name: 'Nebraska Department of Labor', category: 'government', verified_numbers: ['+18559958863'], spoof_message: 'NDOL will NEVER ask for your password, PIN, or SSN by phone. HANG UP.' , contact_urls: ['https://dol.nebraska.gov/ContactUs'], },
  { name: 'Nevada DETR (Unemployment)', category: 'government', verified_numbers: ['+17024860350'], spoof_message: 'Nevada DETR will NEVER ask for your password, PIN, or SSN by phone. HANG UP.' , contact_urls: ['https://detr.nv.gov/Page/Contact_Us'], },
  { name: 'New Hampshire Employment Security', category: 'government', verified_numbers: ['+18008523400'], spoof_message: 'NH NHES will NEVER ask for your password, PIN, or SSN by phone. HANG UP.' , contact_urls: ['https://www.nhes.nh.gov/resources/contact-us'], },
  { name: 'New Jersey Department of Labor', category: 'government', verified_numbers: ['+17327612020'], spoof_message: 'NJ DOL will NEVER ask for your password, PIN, or SSN by phone. HANG UP.' , contact_urls: ['https://www.nj.gov/labor/aboutlwd/contactus.shtml'], },
  { name: 'New Mexico Department of Workforce Solutions', category: 'government', verified_numbers: ['+18776646984'], spoof_message: 'NM DWS will NEVER ask for your password, PIN, or SSN by phone. HANG UP.' , contact_urls: ['https://www.dws.state.nm.us/en-us/Contact-Us'], },
  { name: 'New York Department of Labor (Unemployment)', category: 'government', verified_numbers: ['+18882098124'], spoof_message: 'NY DOL will NEVER ask for your password, PIN, or SSN by phone. HANG UP and file at labor.ny.gov directly.' , contact_urls: ['https://dol.ny.gov/contact-dol'], },
  { name: 'North Carolina Division of Employment Security', category: 'government', verified_numbers: ['+18887370259'], spoof_message: 'NC DES will NEVER ask for your password, PIN, or SSN by phone. HANG UP.' , contact_urls: ['https://www.des.nc.gov/about/contact-us'], },
  { name: 'North Dakota Job Service', category: 'government', verified_numbers: ['+17013282825'], spoof_message: 'ND Job Service will NEVER ask for your password, PIN, or SSN by phone. HANG UP.' , contact_urls: ['https://www.jobsnd.com/contact-us'], },
  { name: 'Ohio ODJFS (Unemployment)', category: 'government', verified_numbers: ['+18776446562'], spoof_message: 'Ohio ODJFS will NEVER ask for your password, PIN, or SSN by phone. HANG UP.' , contact_urls: ['https://jfs.ohio.gov/contact-us'], },
  { name: 'Oklahoma Employment Security Commission', category: 'government', verified_numbers: ['+14055251500'], spoof_message: 'OK OESC will NEVER ask for your password, PIN, or SSN by phone. HANG UP.' , contact_urls: ['https://oklahoma.gov/oesc/about/contact-oesc.html'], },
  { name: 'Oregon Employment Department', category: 'government', verified_numbers: ['+18773453484'], spoof_message: 'Oregon Employment will NEVER ask for your password, PIN, or SSN by phone. HANG UP.' , contact_urls: ['https://unemployment.oregon.gov/contact'], },
  { name: 'Pennsylvania Unemployment Compensation', category: 'government', verified_numbers: ['+18883137284'], spoof_message: 'PA UC will NEVER ask for your password, PIN, or SSN by phone. HANG UP.' , contact_urls: ['https://www.uc.pa.gov/contact-us/Pages/default.aspx'], },
  { name: 'Rhode Island Department of Labor and Training', category: 'government', verified_numbers: ['+14014156772'], spoof_message: 'RI DLT will NEVER ask for your password, PIN, or SSN by phone. HANG UP.' , contact_urls: ['https://dlt.ri.gov/about-us/contact-us'], },
  { name: 'South Carolina Department of Employment and Workforce', category: 'government', verified_numbers: ['+18668311724'], spoof_message: 'SC DEW will NEVER ask for your password, PIN, or SSN by phone. HANG UP.' , contact_urls: ['https://dew.sc.gov/contact-us'], },
  { name: 'South Dakota Department of Labor and Regulation', category: 'government', verified_numbers: ['+16056262452'], spoof_message: 'SD DLR will NEVER ask for your password, PIN, or SSN by phone. HANG UP.' , contact_urls: ['https://dlr.sd.gov/contact_us.aspx'], },
  { name: 'Tennessee Department of Labor and Workforce Development', category: 'government', verified_numbers: ['+18442245818'], spoof_message: 'Tennessee TDLWD will NEVER ask for your password, PIN, or SSN by phone. HANG UP.' , /* contact_urls: intentionally omitted — tn.gov connection-resets our IP */ },
  { name: 'Texas Workforce Commission', category: 'government', verified_numbers: ['+18009396631'], spoof_message: 'Texas TWC will NEVER ask for your password, PIN, or SSN by phone. HANG UP.' , contact_urls: ['https://www.twc.texas.gov/contact-twc'], },
  { name: 'Utah Department of Workforce Services', category: 'government', verified_numbers: ['+18015264400'], spoof_message: 'Utah DWS will NEVER ask for your password, PIN, or SSN by phone. HANG UP.' , contact_urls: ['https://jobs.utah.gov/contact/index.html'], },
  { name: 'Vermont Department of Labor', category: 'government', verified_numbers: ['+18772143330'], spoof_message: 'Vermont DOL will NEVER ask for your password, PIN, or SSN by phone. HANG UP.' , contact_urls: ['https://labor.vermont.gov/contact-us'], },
  { name: 'Virginia Employment Commission', category: 'government', verified_numbers: ['+18668322363'], spoof_message: 'Virginia VEC will NEVER ask for your password, PIN, or SSN by phone. HANG UP.' , contact_urls: ['https://www.vec.virginia.gov/contact-us'], },
  { name: 'Washington Employment Security Department', category: 'government', verified_numbers: ['+18003186022'], spoof_message: 'Washington ESD will NEVER ask for your password, PIN, or SSN by phone. HANG UP.' , contact_urls: ['https://esd.wa.gov/about-us/contact-us'], },
  { name: 'West Virginia Workforce', category: 'government', verified_numbers: ['+18002525627'], spoof_message: 'WV Workforce will NEVER ask for your password, PIN, or SSN by phone. HANG UP.' , contact_urls: ['https://workforcewv.org/about-workforce-wv/department-directory/'], },
  { name: 'Wisconsin Department of Workforce Development', category: 'government', verified_numbers: ['+14144357069'], spoof_message: 'Wisconsin DWD will NEVER ask for your password, PIN, or SSN by phone. HANG UP.' , contact_urls: ['https://dwd.wisconsin.gov/dwd/contact-us.htm'], },
  { name: 'Wyoming Department of Workforce Services', category: 'government', verified_numbers: ['+13074733789'], spoof_message: 'Wyoming WYDWS will NEVER ask for your password, PIN, or SSN by phone. HANG UP.' , contact_urls: ['https://dws.wyo.gov/contact-us/'], },

  // ===== Additional top-50 US credit unions =====

  { name: 'Alaska USA Federal Credit Union', category: 'credit_union', verified_numbers: ['+18005259094'], spoof_message: 'This IS the real Alaska USA FCU line — scammers frequently spoof military-affinity CUs. NEVER share password or MFA codes by phone.' , contact_urls: ['https://www.globalcu.org/support/'], },
  { name: 'Americas First Federal Credit Union', category: 'credit_union', verified_numbers: ['+18006338442'], spoof_message: 'This IS the real America\'s First FCU line — scammers spoof AL-area CUs. NEVER share password or codes by phone.' , contact_urls: ['https://www.amfirst.org/why/about-amfirst/about-us/contact-us/'], },
  { name: 'Bellco Credit Union', category: 'credit_union', verified_numbers: ['+18002355261'], spoof_message: 'This IS the real Bellco CU line. NEVER share password or codes by phone.' , contact_urls: ['https://www.bellco.org/contact-us/'], },
  { name: 'BCU (Baxter Credit Union)', category: 'credit_union', verified_numbers: ['+18003887000'], spoof_message: 'This IS the real BCU line. NEVER share password or codes by phone.' , contact_urls: ['https://www.bcu.org/contact-us'], },
  { name: 'Connexus Credit Union', category: 'credit_union', verified_numbers: ['+18008455025'], spoof_message: 'This IS the real Connexus CU line. NEVER share password or codes by phone.' , contact_urls: ['https://www.connexuscu.org/about/contact-us'], },
  { name: 'Desert Financial Credit Union', category: 'credit_union', verified_numbers: ['+16024337000'], spoof_message: 'This IS the real Desert Financial CU line. NEVER share password or codes by phone.' , contact_urls: ['https://www.desertfinancial.com/contact'], },
  { name: 'Educators Credit Union', category: 'credit_union', verified_numbers: ['+18002365898'], spoof_message: 'This IS the real Educators CU line. NEVER share password or codes by phone.' , contact_urls: ['https://www.ecu.com/contact-us/'], },
  { name: 'ESL Federal Credit Union', category: 'credit_union', verified_numbers: ['+18008482265'], spoof_message: 'This IS the real ESL FCU line. NEVER share password or codes by phone.' , contact_urls: ['https://www.esl.org/contact-us'], },
  { name: 'GTE Financial', category: 'credit_union', verified_numbers: ['+18138712690'], spoof_message: 'This IS the real GTE Financial line. NEVER share password or codes by phone.' , contact_urls: ['https://www.gtefinancial.org/about/contact'], },
  { name: 'Hudson Valley Credit Union', category: 'credit_union', verified_numbers: ['+18454633011'], spoof_message: 'This IS the real Hudson Valley CU line. NEVER share password or codes by phone.' , contact_urls: ['https://www.hvcu.org/contact-us/'], },
  { name: 'Idaho Central Credit Union', category: 'credit_union', verified_numbers: ['+12082393000'], spoof_message: 'This IS the real Idaho Central CU line. NEVER share password or codes by phone.' , contact_urls: ['https://www.iccu.com/contact/'], },
  { name: 'Keesler Federal Credit Union', category: 'credit_union', verified_numbers: ['+18002809566'], spoof_message: 'This IS the real Keesler FCU line — military-affinity CU, top scam target. NEVER share password or codes by phone.' , contact_urls: ['https://www.kfcu.org/contact/'], },
  { name: 'Kinecta Federal Credit Union', category: 'credit_union', verified_numbers: ['+18008549846'], spoof_message: 'This IS the real Kinecta FCU line. NEVER share password or codes by phone.' , contact_urls: ['https://www.kinecta.org/contact-us'], },
  { name: 'Lake Trust Credit Union', category: 'credit_union', verified_numbers: ['+18882677200'], spoof_message: 'This IS the real Lake Trust CU line. NEVER share password or codes by phone.' , contact_urls: ['https://laketrust.org/contact-us/'], },
  { name: 'Michigan State University Federal Credit Union', category: 'credit_union', verified_numbers: ['+18006784968'], spoof_message: 'This IS the real MSUFCU line. NEVER share password or codes by phone.' , contact_urls: ['https://www.msufcu.org/contact/'], },
  { name: 'Mission Federal Credit Union', category: 'credit_union', verified_numbers: ['+18005006328'], spoof_message: 'This IS the real Mission FCU line. NEVER share password or codes by phone.' , contact_urls: ['https://www.missionfed.com/help-resources/'], },
  { name: 'Quorum Federal Credit Union', category: 'credit_union', verified_numbers: ['+18008745544'], spoof_message: 'This IS the real Quorum FCU line. NEVER share password or codes by phone.' , contact_urls: ['https://www.quorumfcu.org/contact-us/'], },
  { name: 'Redstone Federal Credit Union', category: 'credit_union', verified_numbers: ['+18002341234'], spoof_message: 'This IS the real Redstone FCU line — military-affinity CU. NEVER share password or codes by phone.' , contact_urls: ['https://www.redfcu.org/contact-page/'], },
  { name: 'Service Credit Union', category: 'credit_union', verified_numbers: ['+18009367730'], spoof_message: 'This IS the real Service CU line — military-affinity CU. NEVER share password or codes by phone.' , contact_urls: ['https://servicecu.org/contact/'], },
  { name: 'Space Coast Credit Union', category: 'credit_union', verified_numbers: ['+18004477228'], spoof_message: 'This IS the real Space Coast CU line. NEVER share password or codes by phone.' , contact_urls: ['https://www.sccu.com/contact-us'], },
  { name: 'Summit Credit Union (WI)', category: 'credit_union', verified_numbers: ['+18002365560'], spoof_message: 'This IS the real Summit CU line. NEVER share password or codes by phone.' , contact_urls: ['https://www.summitcreditunion.com/contact-us/'], },
  { name: 'Star One Credit Union', category: 'credit_union', verified_numbers: ['+18665435202'], spoof_message: 'This IS the real Star One CU line. NEVER share password or codes by phone.' , contact_urls: ['https://www.starone.org/contact-us/'], },
  { name: 'United Federal Credit Union', category: 'credit_union', verified_numbers: ['+18889821400'], spoof_message: 'This IS the real United FCU line. NEVER share password or codes by phone.' , contact_urls: ['https://unitedfcu.com/contact-us'], },
  { name: 'VantageWest Credit Union', category: 'credit_union', verified_numbers: ['+18008887882'], spoof_message: 'This IS the real VantageWest CU line. NEVER share password or codes by phone.' , contact_urls: ['https://vantagewest.org/contact-us/'], },
  { name: 'Visions Federal Credit Union', category: 'credit_union', verified_numbers: ['+18002422120'], spoof_message: 'This IS the real Visions FCU line. NEVER share password or codes by phone.' , contact_urls: ['https://www.visionsfcu.org/contact-us'], },

  // ===== Additional regional banks =====

  { name: 'Atlantic Union Bank', category: 'bank', verified_numbers: ['+18009904828'], spoof_message: 'This IS the real Atlantic Union Bank line — scammers spoof VA-area banks. HANG UP and call the number on your card.' , contact_urls: ['https://www.atlanticunionbank.com/about/contact-us'], },
  { name: 'Ameris Bank', category: 'bank', verified_numbers: ['+18666166020'], spoof_message: 'This IS the real Ameris Bank line — scammers spoof GA/FL/AL-area banks. HANG UP and call the number on your card.' , contact_urls: ['https://banks.amerisbank.com/'], },
  { name: 'Arvest Bank', category: 'bank', verified_numbers: ['+18669529523'], spoof_message: 'This IS the real Arvest Bank line — scammers spoof AR/OK/MO-area banks. HANG UP and call the number on your card.' , contact_urls: ['https://www.arvest.com/contact'], },
  { name: 'Bank of Hope', category: 'bank', verified_numbers: ['+12136391700'], spoof_message: 'This IS the real Bank of Hope line. HANG UP and call the number on your card.' , contact_urls: ['https://www.bankofhope.com/contact-us'], },
  { name: 'Bank OZK', category: 'bank', verified_numbers: ['+18002744482'], spoof_message: 'This IS the real Bank OZK line. HANG UP and call the number on your card.' , contact_urls: ['https://www.ozk.com/contact-us'], },
  { name: 'Commerce Bank', category: 'bank', verified_numbers: ['+18004532265'], spoof_message: 'This IS the real Commerce Bank line — scammers spoof MO-area banks. HANG UP and call the number on your card.' , contact_urls: ['https://www.commercebank.com/contact-us'], },
  { name: 'EverBank', category: 'bank', verified_numbers: ['+18888823837'], spoof_message: 'This IS the real EverBank line. HANG UP and call the number on your card.' , contact_urls: ['https://www.everbank.com/support/contact'], },
  { name: 'First Hawaiian Bank', category: 'bank', verified_numbers: ['+18888444444'], spoof_message: 'This IS the real First Hawaiian Bank line. HANG UP and call the number on your card.' , contact_urls: ['https://www.fhb.com/en/contact-us'], },
  { name: 'First National Bank of Omaha', category: 'bank', verified_numbers: ['+18885303626'], spoof_message: 'This IS the real FNBO line. HANG UP and call the number on your card.' , contact_urls: ['https://www.fnbo.com/contact-us/'], },
  { name: 'FNB Corp', category: 'bank', verified_numbers: ['+18005555455'], spoof_message: 'This IS the real FNB line (First National Bank of PA). HANG UP and call the number on your card.' , contact_urls: ['https://www.fnb-online.com/contact-us'], },
  { name: 'Hancock Whitney Bank', category: 'bank', verified_numbers: ['+18004488812'], spoof_message: 'This IS the real Hancock Whitney Bank line — scammers spoof Gulf-coast banks. HANG UP and call the number on your card.' , contact_urls: ['https://www.hancockwhitney.com/contact-us'], },
  { name: 'Northwest Bank', category: 'bank', verified_numbers: ['+18002437325'], spoof_message: 'This IS the real Northwest Bank line. HANG UP and call the number on your card.' , contact_urls: ['https://www.northwest.bank/contact-us'], },
  { name: 'Pacific Premier Bank', category: 'bank', verified_numbers: ['+18557742265'], spoof_message: 'This IS the real Pacific Premier Bank line. HANG UP and call the number on your card.' , contact_urls: ['https://www.ppbi.com/contact-us.html'], },
  { name: 'Renasant Bank', category: 'bank', verified_numbers: ['+18006801601'], spoof_message: 'This IS the real Renasant Bank line — scammers spoof MS/AL-area banks. HANG UP and call the number on your card.' , contact_urls: ['https://www.renasantbank.com/resources/faqs'], },
  { name: 'Sandy Spring Bank', category: 'bank', verified_numbers: ['+18003995919'], spoof_message: 'This IS the real Sandy Spring Bank line — scammers spoof MD/VA-area banks. HANG UP and call the number on your card.' , contact_urls: ['https://www.atlanticunionbank.com/about/contact-us'], },
  { name: 'Texas Capital Bank', category: 'bank', verified_numbers: ['+18778392265'], spoof_message: 'This IS the real Texas Capital Bank line. HANG UP and call the number on your card.' , contact_urls: ['https://www.texascapitalbank.com/contact-us'], },
  { name: 'Trustmark Bank', category: 'bank', verified_numbers: ['+18008442400'], spoof_message: 'This IS the real Trustmark Bank line — scammers spoof MS/AL-area banks. HANG UP and call the number on your card.' , contact_urls: ['https://www.trustmark.com/contact-us'], },
  { name: 'WaFd Bank (Washington Federal)', category: 'bank', verified_numbers: ['+18003249375'], spoof_message: 'This IS the real WaFd Bank line. HANG UP and call the number on your card.' , contact_urls: ['https://www.wafdbank.com/contact-us'], },
  { name: 'WesBanco', category: 'bank', verified_numbers: ['+18009059043'], spoof_message: 'This IS the real WesBanco line — scammers spoof WV/OH/PA-area banks. HANG UP and call the number on your card.' , contact_urls: ['https://www.wesbanco.com/contact/'], },
  { name: 'Wintrust', category: 'bank', verified_numbers: ['+13126014275'], spoof_message: 'This IS the real Wintrust line — scammers spoof Chicago-area banks. HANG UP and call the number on your card.' , contact_urls: ['https://www.wintrust.com/contact-us.html'], },

  // ===== All 50 state Attorney General offices (+ DC) =====
  // Impersonated in "you\'re being sued / lawsuit judgment" scams.

  { name: 'Alabama Attorney General', category: 'government', verified_numbers: ['+13342427300'], spoof_message: 'The AL AG will NEVER demand payment by phone. They send formal letters. HANG UP.' , contact_urls: ['https://www.alabamaag.gov/general-contact/'], },
  { name: 'Alaska Attorney General', category: 'government', verified_numbers: ['+19074653600'], spoof_message: 'The AK AG will NEVER demand payment by phone. HANG UP.' , contact_urls: ['https://law.alaska.gov/department/contacts.html'], },
  { name: 'Arizona Attorney General', category: 'government', verified_numbers: ['+16025425025'], spoof_message: 'The AZ AG will NEVER demand payment by phone. HANG UP.' , contact_urls: ['https://www.azag.gov/contact-us'], },
  { name: 'Arkansas Attorney General', category: 'government', verified_numbers: ['+18004828982'], spoof_message: 'The AR AG will NEVER demand payment by phone. HANG UP.' , contact_urls: ['https://arkansasag.gov/contact-us/'], },
  { name: 'California Attorney General', category: 'government', verified_numbers: ['+19162106276'], spoof_message: 'The CA AG will NEVER demand payment by phone. Report scam calls at oag.ca.gov. HANG UP.' , contact_urls: ['https://oag.ca.gov/contact'], },
  { name: 'Colorado Attorney General', category: 'government', verified_numbers: ['+17205086000'], spoof_message: 'The CO AG will NEVER demand payment by phone. HANG UP.' , contact_urls: ['https://coag.gov/file-complaint/'], },
  { name: 'Connecticut Attorney General', category: 'government', verified_numbers: ['+18608085318'], spoof_message: 'The CT AG will NEVER demand payment by phone. HANG UP.' , contact_urls: ['https://portal.ct.gov/AG/Common-Elements/Common-Footer-Nav/Contact-Us'], },
  { name: 'Delaware Attorney General', category: 'government', verified_numbers: ['+18002205424'], spoof_message: 'The DE AG will NEVER demand payment by phone. HANG UP.' , contact_urls: ['https://attorneygeneral.delaware.gov/contact/'], },
  { name: 'DC Attorney General', category: 'government', verified_numbers: ['+12024429828'], spoof_message: 'The DC AG will NEVER demand payment by phone. HANG UP.' , contact_urls: ['https://oag.dc.gov/about-oag/contact-us'], },
  { name: 'Florida Attorney General', category: 'government', verified_numbers: ['+18669667226'], spoof_message: 'The FL AG will NEVER demand payment by phone. HANG UP.' , contact_urls: ['https://www.myfloridalegal.com/how-to-contact-us/file-a-complaint'], },
  { name: 'Georgia Attorney General', category: 'government', verified_numbers: ['+14046518600'], spoof_message: 'The GA AG will NEVER demand payment by phone. HANG UP.' , contact_urls: ['https://law.georgia.gov/contact-us'], },
  { name: 'Hawaii Attorney General', category: 'government', verified_numbers: ['+18085861500'], spoof_message: 'The HI AG will NEVER demand payment by phone. HANG UP.' , contact_urls: ['https://ag.hawaii.gov/contact-us/'], },
  { name: 'Idaho Attorney General', category: 'government', verified_numbers: ['+12083342400'], spoof_message: 'The ID AG will NEVER demand payment by phone. HANG UP.' , contact_urls: ['https://www.ag.idaho.gov/contact/'], },
  { name: 'Illinois Attorney General', category: 'government', verified_numbers: ['+18003865438'], spoof_message: 'The IL AG will NEVER demand payment by phone. HANG UP.' , contact_urls: ['https://illinoisattorneygeneral.gov/Contact/'], },
  { name: 'Indiana Attorney General', category: 'government', verified_numbers: ['+18003825516'], spoof_message: 'The IN AG will NEVER demand payment by phone. HANG UP.' , contact_urls: ['https://www.in.gov/attorneygeneral/contact-us/'], },
  { name: 'Iowa Attorney General', category: 'government', verified_numbers: ['+15152815164'], spoof_message: 'The IA AG will NEVER demand payment by phone. HANG UP.' , contact_urls: ['https://www.iowaattorneygeneral.gov/contact-us'], },
  { name: 'Kansas Attorney General', category: 'government', verified_numbers: ['+18004322310'], spoof_message: 'The KS AG will NEVER demand payment by phone. HANG UP.' , contact_urls: ['https://www.ag.ks.gov/about-us/contact-us'], },
  { name: 'Kentucky Attorney General', category: 'government', verified_numbers: ['+18884329257'], spoof_message: 'The KY AG will NEVER demand payment by phone. HANG UP.' , contact_urls: ['https://ag.ky.gov/'], },
  { name: 'Louisiana Attorney General', category: 'government', verified_numbers: ['+18003514889'], spoof_message: 'The LA AG will NEVER demand payment by phone. HANG UP.' , contact_urls: ['https://www.ag.state.la.us/Contact'], },
  { name: 'Maine Attorney General', category: 'government', verified_numbers: ['+12076268800'], spoof_message: 'The ME AG will NEVER demand payment by phone. HANG UP.' , contact_urls: ['https://www.maine.gov/ag/contact.html'], },
  { name: 'Maryland Attorney General', category: 'government', verified_numbers: ['+14105766300'], spoof_message: 'The MD AG will NEVER demand payment by phone. HANG UP.' , contact_urls: ['https://www.marylandattorneygeneral.gov/Pages/contactus.aspx'], },
  { name: 'Massachusetts Attorney General', category: 'government', verified_numbers: ['+16177272200'], spoof_message: 'The MA AG will NEVER demand payment by phone. HANG UP.' , contact_urls: ['https://www.mass.gov/contact-the-attorney-generals-office'], },
  { name: 'Michigan Attorney General', category: 'government', verified_numbers: ['+15173357622'], spoof_message: 'The MI AG will NEVER demand payment by phone. HANG UP.' , contact_urls: ['https://www.michigan.gov/ag/ag-contact-directory'], },
  { name: 'Minnesota Attorney General', category: 'government', verified_numbers: ['+18006573787'], spoof_message: 'The MN AG will NEVER demand payment by phone. HANG UP.' , contact_urls: ['https://www.ag.state.mn.us/office/contactus.asp'], },
  { name: 'Mississippi Attorney General', category: 'government', verified_numbers: ['+18002814418'], spoof_message: 'The MS AG will NEVER demand payment by phone. HANG UP.' , contact_urls: ['https://attorneygenerallynnfitch.com/contact/'], },
  { name: 'Missouri Attorney General', category: 'government', verified_numbers: ['+15737513321'], spoof_message: 'The MO AG will NEVER demand payment by phone. HANG UP.' , contact_urls: ['https://ago.mo.gov/contact-us/'], },
  { name: 'Montana Attorney General', category: 'government', verified_numbers: ['+14064442026'], spoof_message: 'The MT AG will NEVER demand payment by phone. HANG UP.' , contact_urls: ['https://dojmt.gov/contact-mt-doj/'], },
  { name: 'Nebraska Attorney General', category: 'government', verified_numbers: ['+18007276432'], spoof_message: 'The NE AG will NEVER demand payment by phone. HANG UP.' , contact_urls: ['https://ago.nebraska.gov/contact-us'], },
  { name: 'Nevada Attorney General', category: 'government', verified_numbers: ['+17024863420'], spoof_message: 'The NV AG will NEVER demand payment by phone. HANG UP.' , contact_urls: ['https://ag.nv.gov/About/Contact/Contact_AG/'], },
  { name: 'New Hampshire Attorney General', category: 'government', verified_numbers: ['+16032713658'], spoof_message: 'The NH AG will NEVER demand payment by phone. HANG UP.' , contact_urls: ['https://www.doj.nh.gov/contact-us'], },
  { name: 'New Jersey Attorney General', category: 'government', verified_numbers: ['+16092924925'], spoof_message: 'The NJ AG will NEVER demand payment by phone. HANG UP.' , contact_urls: ['https://www.njoag.gov/contact/'], },
  { name: 'New Mexico Attorney General', category: 'government', verified_numbers: ['+18442559210'], spoof_message: 'The NM AG will NEVER demand payment by phone. HANG UP.' , contact_urls: ['https://nmdoj.gov/contact-us/'], },
  { name: 'New York Attorney General', category: 'government', verified_numbers: ['+18007717755'], spoof_message: 'The NY AG will NEVER demand payment by phone. They prosecute scammers, not collect from victims. HANG UP.' , contact_urls: ['https://ag.ny.gov/contact-attorney-general-letitia-james'], },
  { name: 'North Carolina Attorney General', category: 'government', verified_numbers: ['+19197166400'], spoof_message: 'The NC AG will NEVER demand payment by phone. HANG UP.' , contact_urls: ['https://ncdoj.gov/contact/'], },
  { name: 'North Dakota Attorney General', category: 'government', verified_numbers: ['+18004722600'], spoof_message: 'The ND AG will NEVER demand payment by phone. HANG UP.' , contact_urls: ['https://attorneygeneral.nd.gov/attorney-generals-office/contact-us/'], },
  { name: 'Ohio Attorney General', category: 'government', verified_numbers: ['+18002820515'], spoof_message: 'The OH AG will NEVER demand payment by phone. HANG UP.' , contact_urls: ['https://www.ohioattorneygeneral.gov/About-AG/Contact'], },
  { name: 'Oklahoma Attorney General', category: 'government', verified_numbers: ['+14055213921'], spoof_message: 'The OK AG will NEVER demand payment by phone. HANG UP.' , contact_urls: ['https://oklahoma.gov/oag/about/contact.html'], },
  { name: 'Oregon Attorney General', category: 'government', verified_numbers: ['+15033784400'], spoof_message: 'The OR AG will NEVER demand payment by phone. HANG UP.' , contact_urls: ['https://www.doj.state.or.us/oregon-department-of-justice/contact-us/'], },
  { name: 'Pennsylvania Attorney General', category: 'government', verified_numbers: ['+18004412555'], spoof_message: 'The PA AG will NEVER demand payment by phone. HANG UP.' , contact_urls: ['https://www.attorneygeneral.gov/contact/'], },
  { name: 'Rhode Island Attorney General', category: 'government', verified_numbers: ['+14012744400'], spoof_message: 'The RI AG will NEVER demand payment by phone. HANG UP.' , contact_urls: ['https://riag.ri.gov/about-our-office/contact-us'], },
  { name: 'South Carolina Attorney General', category: 'government', verified_numbers: ['+18037343970'], spoof_message: 'The SC AG will NEVER demand payment by phone. HANG UP.' , contact_urls: ['https://www.scag.gov/about-the-office/contact-us/'], },
  { name: 'South Dakota Attorney General', category: 'government', verified_numbers: ['+16057733215'], spoof_message: 'The SD AG will NEVER demand payment by phone. HANG UP.' , contact_urls: ['https://atg.sd.gov/OurOffice/contact.aspx'], },
  { name: 'Tennessee Attorney General', category: 'government', verified_numbers: ['+16157413491'], spoof_message: 'The TN AG will NEVER demand payment by phone. HANG UP.' , contact_urls: ['https://www.tn.gov/attorneygeneral/contact-us.html'], },
  { name: 'Texas Attorney General', category: 'government', verified_numbers: ['+18006210508'], spoof_message: 'The TX AG will NEVER demand payment by phone. HANG UP.' , contact_urls: ['https://www.texasattorneygeneral.gov/contact-us'], },
  { name: 'Utah Attorney General', category: 'government', verified_numbers: ['+18013660260'], spoof_message: 'The UT AG will NEVER demand payment by phone. HANG UP.' , contact_urls: ['https://attorneygeneral.utah.gov/contact-us/'], },
  { name: 'Vermont Attorney General', category: 'government', verified_numbers: ['+18028283171'], spoof_message: 'The VT AG will NEVER demand payment by phone. HANG UP.' , contact_urls: ['https://ago.vermont.gov/contact'], },
  { name: 'Virginia Attorney General', category: 'government', verified_numbers: ['+18005529963'], spoof_message: 'The VA AG will NEVER demand payment by phone. HANG UP.' , contact_urls: ['https://www.oag.state.va.us/contact-us/contact-info'], },
  { name: 'Washington Attorney General', category: 'government', verified_numbers: ['+18005514636'], spoof_message: 'The WA AG will NEVER demand payment by phone. HANG UP.' , contact_urls: ['https://www.atg.wa.gov/contact-us'], },
  { name: 'West Virginia Attorney General', category: 'government', verified_numbers: ['+18003688808'], spoof_message: 'The WV AG will NEVER demand payment by phone. HANG UP.' , contact_urls: ['https://ago.wv.gov/contact-us-0'], },
  { name: 'Wisconsin Attorney General', category: 'government', verified_numbers: ['+16082661221'], spoof_message: 'The WI AG will NEVER demand payment by phone. HANG UP.' , contact_urls: ['https://www.doj.state.wi.us/office-attorney-general/contact-attorney-general'], },
  { name: 'Wyoming Attorney General', category: 'government', verified_numbers: ['+13077777841'], spoof_message: 'The WY AG will NEVER demand payment by phone. HANG UP.' , contact_urls: ['https://ag.wyo.gov/contact-us'], },

  // ===== Top 14 state BCBS plans =====

  { name: 'Blue Cross Blue Shield of Texas', category: 'healthcare', verified_numbers: ['+18005212227'], spoof_message: 'This IS the real BCBS of TX line — scammers spoof health plans for Medicare enrollment scams. BCBS will NEVER ask for SSN by phone. HANG UP.' , contact_urls: ['https://www.bcbstx.com/contact'], },
  { name: 'Anthem Blue Cross (California)', category: 'healthcare', verified_numbers: ['+18003330912'], spoof_message: 'This IS the real Anthem BC of CA line — scammers spoof it heavily. Anthem will NEVER ask for SSN by phone. HANG UP.' , contact_urls: ['https://www.anthem.com/ca/contact-us/'], },
  { name: 'BCBS of Michigan', category: 'healthcare', verified_numbers: ['+18774693711'], spoof_message: 'This IS the real BCBS of MI line. BCBS will NEVER ask for SSN by phone. HANG UP.' , contact_urls: ['https://www.bcbsm.com/individuals/help/contact-us/'], },
  { name: 'BCBS of Illinois', category: 'healthcare', verified_numbers: ['+18005388833'], spoof_message: 'This IS the real BCBS of IL line. BCBS will NEVER ask for SSN by phone. HANG UP.' , contact_urls: ['https://www.bcbsil.com/contact'], },
  { name: 'Florida Blue (BCBS)', category: 'healthcare', verified_numbers: ['+18003522583'], spoof_message: 'This IS the real Florida Blue line. Florida Blue will NEVER ask for SSN by phone. HANG UP.' , contact_urls: ['https://www.floridablue.com/help/contact-us'], },
  { name: 'Highmark BCBS (Pennsylvania)', category: 'healthcare', verified_numbers: ['+18668238524'], spoof_message: 'This IS the real Highmark BCBS line. Highmark will NEVER ask for SSN by phone. HANG UP.' , contact_urls: ['https://www.highmark.com/contact'], },
  { name: 'Horizon BCBS New Jersey', category: 'healthcare', verified_numbers: ['+18003552583'], spoof_message: 'This IS the real Horizon BCBS NJ line. Horizon will NEVER ask for SSN by phone. HANG UP.' , contact_urls: ['https://www.horizonblue.com/contact-us'], },
  { name: 'Anthem BCBS (multi-state)', category: 'healthcare', verified_numbers: ['+18003311476'], spoof_message: 'This IS the real Anthem BCBS line. Anthem will NEVER ask for SSN by phone. HANG UP.' , contact_urls: ['https://www.anthem.com/contact-us/'], },
  { name: 'Independence Blue Cross (Pennsylvania)', category: 'healthcare', verified_numbers: ['+18002752583'], spoof_message: 'This IS the real Independence Blue Cross line. IBC will NEVER ask for SSN by phone. HANG UP.' , contact_urls: ['https://www.ibx.com/contact-us'], },
  { name: 'CareFirst BCBS (MD/DC/VA)', category: 'healthcare', verified_numbers: ['+18005448703'], spoof_message: 'This IS the real CareFirst BCBS line. CareFirst will NEVER ask for SSN by phone. HANG UP.' , contact_urls: ['https://member.carefirst.com/members/contact-us/contact-us.page'], },
  { name: 'Blue Cross Blue Shield of Massachusetts', category: 'healthcare', verified_numbers: ['+18002622583'], spoof_message: 'This IS the real BCBS of MA line. BCBS will NEVER ask for SSN by phone. HANG UP.' , contact_urls: ['http://www.bluecrossma.com/municipal/city-of-boston/resources/contact-us.html'], },
  { name: 'Blue Cross Blue Shield of North Carolina', category: 'healthcare', verified_numbers: ['+18003244973'], spoof_message: 'This IS the real BCBS of NC line. BCBS will NEVER ask for SSN by phone. HANG UP.' , contact_urls: ['https://www.bluecrossnc.com/contact-us/call'], },
  { name: 'Premera Blue Cross (Washington)', category: 'healthcare', verified_numbers: ['+18007221471'], spoof_message: 'This IS the real Premera Blue Cross line. Premera will NEVER ask for SSN by phone. HANG UP.' , contact_urls: ['https://www.premera.com/contact-us/'], },
  { name: 'Regence BCBS (OR/WA/ID/UT)', category: 'healthcare', verified_numbers: ['+18886756570'], spoof_message: 'This IS the real Regence BCBS line. Regence will NEVER ask for SSN by phone. HANG UP.' , contact_urls: ['https://www.regence.com/contact-us'], },

  // ===== Store credit cards (common in "card declined" scam calls) =====

  { name: 'Target REDcard', category: 'credit_card', verified_numbers: ['+18004246888'], spoof_message: 'This IS the real Target REDcard line. HANG UP and use the Target app to verify any card issue.' , contact_urls: ['https://www.target.com/help/contact-us/target-circle-card'], },
  { name: 'Home Depot Credit Card', category: 'credit_card', verified_numbers: ['+18668755488'], spoof_message: 'This IS the real Home Depot Credit line. HANG UP and call the number on the back of your card.' , contact_urls: ['https://corporate.homedepot.com/page/contact-us'], },
  { name: 'Lowe\'s Credit Card', category: 'credit_card', verified_numbers: ['+18004441408'], spoof_message: 'This IS the real Lowe\'s credit card line. HANG UP and call the number on the back of your card.' , contact_urls: ['https://corporate.lowes.com/contact-us'], },
  { name: 'Macy\'s Credit Card', category: 'credit_card', verified_numbers: ['+18002896229'], spoof_message: 'This IS the real Macy\'s credit card line. HANG UP and call the number on the back of your card.' , /* contact_urls: intentionally omitted — Akamai bot-block */ },
  { name: 'Kohl\'s Credit Card', category: 'credit_card', verified_numbers: ['+18555645748'], spoof_message: 'This IS the real Kohl\'s credit card line. HANG UP and call the number on the back of your card.' , /* contact_urls: intentionally omitted — Akamai bot-block */ },
  { name: 'JCPenney Credit Card', category: 'credit_card', verified_numbers: ['+18005274403'], spoof_message: 'This IS the real JCPenney credit card line. HANG UP and call the number on the back of your card.' , contact_urls: ['https://www.jcpenney.com/m/customer-service'], },
  { name: 'Nordstrom Credit Card', category: 'credit_card', verified_numbers: ['+18009641800'], spoof_message: 'This IS the real Nordstrom credit card line. HANG UP and call the number on the back of your card.' , contact_urls: ['https://www.nordstrom.com/help/contact'], },
  { name: 'Dillard\'s Credit Card', category: 'credit_card', verified_numbers: ['+18006438278'], spoof_message: 'This IS the real Dillard\'s credit card line. HANG UP and call the number on the back of your card.' , contact_urls: ['https://www.dillards.com/c/help-credit-cards'], },
  { name: 'Victoria\'s Secret Credit Card', category: 'credit_card', verified_numbers: ['+18006959478'], spoof_message: 'This IS the real Victoria\'s Secret credit card line. HANG UP and call the number on the back of your card.' , contact_urls: ['https://c.comenity.net/ac/victoriassecret/public/help/bread-financial'], },

  // ===== Additional credit unions (reaching top ~80) =====

  { name: 'San Diego County Credit Union', category: 'credit_union', verified_numbers: ['+18777322848'], spoof_message: 'This IS the real SDCCU line. SDCCU will NEVER ask for password or codes by phone. HANG UP.' , contact_urls: ['https://www.sdccu.com/about/contact/'], },
  { name: 'Redwood Credit Union', category: 'credit_union', verified_numbers: ['+18004797928'], spoof_message: 'This IS the real Redwood CU line. NEVER share password or codes by phone. HANG UP.' , contact_urls: ['https://www.redwoodcu.org/about/contact/'], },
  { name: 'Tinker Federal Credit Union', category: 'credit_union', verified_numbers: ['+14057370006'], spoof_message: 'This IS the real Tinker FCU line — military-affinity CU, top scam target. NEVER share password or codes by phone. HANG UP.' , contact_urls: ['https://www.tinkerfcu.org/about-us/contact-us/'], },
  { name: 'Wright-Patt Credit Union', category: 'credit_union', verified_numbers: ['+18007620047'], spoof_message: 'This IS the real Wright-Patt CU line — military-affinity CU. NEVER share password or codes by phone. HANG UP.' , contact_urls: ['https://www.wpcu.coop/contact-us'], },
  { name: 'Wescom Credit Union', category: 'credit_union', verified_numbers: ['+18884937266'], spoof_message: 'This IS the real Wescom CU line. NEVER share password or codes by phone. HANG UP.' , contact_urls: ['https://www.wescom.org/about-us/contact'], },
  { name: 'California Credit Union', category: 'credit_union', verified_numbers: ['+18003348788'], spoof_message: 'This IS the real California CU line. NEVER share password or codes by phone. HANG UP.' , contact_urls: ['https://www.ccu.com/contact-us/'], },
  { name: 'PSECU (Pennsylvania State Employees Credit Union)', category: 'credit_union', verified_numbers: ['+18002377328'], spoof_message: 'This IS the real PSECU line. PSECU will NEVER ask for password or codes by phone. HANG UP.' , contact_urls: ['https://www.psecu.com/contact'], },
  { name: 'TDECU (Texas Dow Employees Credit Union)', category: 'credit_union', verified_numbers: ['+18008391154'], spoof_message: 'This IS the real TDECU line. NEVER share password or codes by phone. HANG UP.' , contact_urls: ['https://www.tdecu.org/contact-us/'], },
  { name: 'Langley Federal Credit Union', category: 'credit_union', verified_numbers: ['+18008267490'], spoof_message: 'This IS the real Langley FCU line — military-affinity CU. NEVER share password or codes by phone. HANG UP.' , contact_urls: ['https://www.langleyfcu.org/contact'], },
  { name: 'Citadel Federal Credit Union', category: 'credit_union', verified_numbers: ['+18006660191'], spoof_message: 'This IS the real Citadel FCU line. NEVER share password or codes by phone. HANG UP.' , contact_urls: ['https://www.citadelbanking.com/about-citadel/customer-support'], },
  { name: 'American Airlines Federal Credit Union', category: 'credit_union', verified_numbers: ['+18005330035'], spoof_message: 'This IS the real American Airlines FCU line. NEVER share password or codes by phone. HANG UP.' , contact_urls: ['https://www.aacreditunion.org/contact-us/'], },
  { name: 'Hughes Federal Credit Union', category: 'credit_union', verified_numbers: ['+15207948341'], spoof_message: 'This IS the real Hughes FCU line. NEVER share password or codes by phone. HANG UP.' , contact_urls: ['https://www.hughesfcu.org/contact'], },
  { name: 'Truliant Federal Credit Union', category: 'credit_union', verified_numbers: ['+18008220382'], spoof_message: 'This IS the real Truliant FCU line. NEVER share password or codes by phone. HANG UP.' , contact_urls: ['https://www.truliantfcu.org/contact-us'], },
  { name: 'Harborstone Credit Union', category: 'credit_union', verified_numbers: ['+18005233641'], spoof_message: 'This IS the real Harborstone CU line. NEVER share password or codes by phone. HANG UP.' , contact_urls: ['https://www.harborstone.com/home/contact-us'], },
  { name: 'Numerica Credit Union', category: 'credit_union', verified_numbers: ['+18004331837'], spoof_message: 'This IS the real Numerica CU line. NEVER share password or codes by phone. HANG UP.' , contact_urls: ['https://www.numericacu.com/contact'], },
  { name: 'Spokane Teachers Credit Union (STCU)', category: 'credit_union', verified_numbers: ['+18008583750'], spoof_message: 'This IS the real STCU line. NEVER share password or codes by phone. HANG UP.' , contact_urls: ['https://stcu.org/contact'], },
  { name: 'CEFCU (Citizens Equity First Credit Union)', category: 'credit_union', verified_numbers: ['+18006337077'], spoof_message: 'This IS the real CEFCU line. NEVER share password or codes by phone. HANG UP.' , contact_urls: ['https://www.cefcu.com/forms/contact/cefcu'], },
  { name: 'Altra Federal Credit Union', category: 'credit_union', verified_numbers: ['+18007550055'], spoof_message: 'This IS the real Altra FCU line. NEVER share password or codes by phone. HANG UP.' , contact_urls: ['https://www.altra.org/contact'], },
  { name: 'Travis Credit Union', category: 'credit_union', verified_numbers: ['+18008778328'], spoof_message: 'This IS the real Travis CU line. NEVER share password or codes by phone. HANG UP.' , contact_urls: ['https://www.traviscu.org/about-us/contact-us/'], },
  { name: 'Elevations Credit Union', category: 'credit_union', verified_numbers: ['+18004297626'], spoof_message: 'This IS the real Elevations CU line. NEVER share password or codes by phone. HANG UP.' , contact_urls: ['https://www.elevationscu.com/contact-us'], },
  { name: 'First Entertainment Credit Union', category: 'credit_union', verified_numbers: ['+18888003328'], spoof_message: 'This IS the real First Entertainment CU line. NEVER share password or codes by phone. HANG UP.' , contact_urls: ['https://www.firstent.org/help/contact-us/'], },
  { name: 'Trumark Financial Credit Union', category: 'credit_union', verified_numbers: ['+18778786275'], spoof_message: 'This IS the real Trumark Financial CU line. NEVER share password or codes by phone. HANG UP.' , contact_urls: ['https://www.trumark.com/contact-us/'], },
  { name: 'Genisys Credit Union', category: 'credit_union', verified_numbers: ['+12483229800'], spoof_message: 'This IS the real Genisys CU line. NEVER share password or codes by phone. HANG UP.' , contact_urls: ['https://www.genisyscu.org/contact-us'], },
  { name: 'CommunityAmerica Credit Union', category: 'credit_union', verified_numbers: ['+18008927957'], spoof_message: 'This IS the real CommunityAmerica CU line. NEVER share password or codes by phone. HANG UP.' , contact_urls: ['https://www.communityamerica.com/contact'], },
  { name: 'MECU Credit Union', category: 'credit_union', verified_numbers: ['+14107528313'], spoof_message: 'This IS the real MECU line. NEVER share password or codes by phone. HANG UP.' , contact_urls: ['https://www.mecu.com/Why-MECU/About/Contact-Us'], },
  { name: 'Tower Federal Credit Union', category: 'credit_union', verified_numbers: ['+13014977000'], spoof_message: 'This IS the real Tower FCU line. NEVER share password or codes by phone. HANG UP.' , contact_urls: ['https://www.towerfcu.org/about/contact'], },
  { name: 'Advancial Federal Credit Union', category: 'credit_union', verified_numbers: ['+18003222436'], spoof_message: 'This IS the real Advancial FCU line. NEVER share password or codes by phone. HANG UP.' , contact_urls: ['https://www.advancial.org/contact-us'], },
  { name: 'Clark County Credit Union', category: 'credit_union', verified_numbers: ['+17022282228'], spoof_message: 'This IS the real Clark County CU line. NEVER share password or codes by phone. HANG UP.' , contact_urls: ['https://www.ccculv.org/Contact-Us'], },
  { name: 'Orange County\'s Credit Union', category: 'credit_union', verified_numbers: ['+18883546228'], spoof_message: 'This IS the real Orange County\'s CU line. NEVER share password or codes by phone. HANG UP.' , contact_urls: ['https://www.orangecountyscu.org/about-us/contact-us/'], },
  { name: 'Consumers Credit Union (IL)', category: 'credit_union', verified_numbers: ['+18772752228'], spoof_message: 'This IS the real Consumers CU line. NEVER share password or codes by phone. HANG UP.' , contact_urls: ['https://www.myconsumers.org/support/contact-us'], },

  // ===== Additional regional banks (top ~85) =====

  { name: 'Hanmi Bank', category: 'bank', verified_numbers: ['+12134275700'], spoof_message: 'This IS the real Hanmi Bank line. HANG UP and call the number on your card.' , contact_urls: ['https://www.hanmi.com/contact-us/'], },
  { name: 'Preferred Bank', category: 'bank', verified_numbers: ['+18009770070'], spoof_message: 'This IS the real Preferred Bank line. HANG UP and call the number on your card.' , contact_urls: ['https://www.preferredbank.com/contact-us/contact-us'], },
  { name: 'Banner Bank', category: 'bank', verified_numbers: ['+18002729933'], spoof_message: 'This IS the real Banner Bank line. HANG UP and call the number on your card.' , contact_urls: ['https://www.bannerbank.com/contact-us'], },
  { name: 'Columbia Banking System (Umpqua)', category: 'bank', verified_numbers: ['+18772723678'], spoof_message: 'This IS the real Columbia / Umpqua line. HANG UP and call the number on your card.' , contact_urls: ['https://www.columbiabank.com/contact-us/'], },
  { name: 'Nicolet Bank', category: 'bank', verified_numbers: ['+18003690226'], spoof_message: 'This IS the real Nicolet Bank line. HANG UP and call the number on your card.' , contact_urls: ['https://www.nicoletbank.com/contact'], },
  { name: 'Simmons Bank', category: 'bank', verified_numbers: ['+18002724663'], spoof_message: 'This IS the real Simmons Bank line. HANG UP and call the number on your card.' , contact_urls: ['https://www.simmonsbank.com/contact'], },
  { name: 'First Merchants Bank', category: 'bank', verified_numbers: ['+18002053464'], spoof_message: 'This IS the real First Merchants line. HANG UP and call the number on your card.' , contact_urls: ['https://www.firstmerchants.com/help/contact'], },
  { name: 'TowneBank', category: 'bank', verified_numbers: ['+17578281000'], spoof_message: 'This IS the real TowneBank line. HANG UP and call the number on your card.' , contact_urls: ['https://www.townebank.com/member-support/contact-us/'], },
  { name: 'Park National Bank', category: 'bank', verified_numbers: ['+17403497000'], spoof_message: 'This IS the real Park National line. HANG UP and call the number on your card.' , contact_urls: ['https://parknationalbank.com/contact-us/'], },
  { name: 'Community Bank System', category: 'bank', verified_numbers: ['+18008602265'], spoof_message: 'This IS the real Community Bank System line. HANG UP and call the number on your card.' , contact_urls: ['https://cbna.com/contact-us'], },
  { name: 'Dime Community Bank', category: 'bank', verified_numbers: ['+18003213463'], spoof_message: 'This IS the real Dime Community Bank line. HANG UP and call the number on your card.' , contact_urls: ['https://www.dime.com/help-portal'], },
  { name: 'Flushing Bank', category: 'bank', verified_numbers: ['+18005812889'], spoof_message: 'This IS the real Flushing Bank line. HANG UP and call the number on your card.' , contact_urls: ['https://www.flushingbank.com/contact-us/'], },
  { name: 'Apple Bank for Savings', category: 'bank', verified_numbers: ['+19149022775'], spoof_message: 'This IS the real Apple Bank for Savings line — NY/NJ regional bank, not related to Apple Inc. HANG UP and call the number on your card.' , contact_urls: ['https://www.applebank.com/contact'], },
  { name: 'BankPlus', category: 'bank', verified_numbers: ['+18002265875'], spoof_message: 'This IS the real BankPlus line. HANG UP and call the number on your card.' , contact_urls: ['https://www.bankplus.net/contact-us/'], },
  { name: 'Mechanics Bank', category: 'bank', verified_numbers: ['+18007976324'], spoof_message: 'This IS the real Mechanics Bank line. HANG UP and call the number on your card.' , contact_urls: ['https://www.mechanicsbank.com/contact-us'], },
  { name: 'Heritage Financial Bank', category: 'bank', verified_numbers: ['+18004556126'], spoof_message: 'This IS the real Heritage Financial line. HANG UP and call the number on your card.' , contact_urls: ['https://www.heritagebanknw.com/home/contact'], },
  { name: 'First Interstate Bank', category: 'bank', verified_numbers: ['+18887523100'], spoof_message: 'This IS the real First Interstate line. HANG UP and call the number on your card.' , contact_urls: ['https://www.firstinterstatebank.com/support'], },
  { name: 'MidFirst Bank', category: 'bank', verified_numbers: ['+18886433477'], spoof_message: 'This IS the real MidFirst Bank line. HANG UP and call the number on your card.' , contact_urls: ['https://www.midfirst.com/contact-us'], },
  { name: 'NBT Bank', category: 'bank', verified_numbers: ['+18006282265'], spoof_message: 'This IS the real NBT Bank line. HANG UP and call the number on your card.' , contact_urls: ['https://www.nbtbank.com/Personal/Customer-Support'], },
  { name: 'Univest Bank', category: 'bank', verified_numbers: ['+18777235571'], spoof_message: 'This IS the real Univest line. HANG UP and call the number on your card.' , contact_urls: ['https://www.univest.net/contact-us'], },
  { name: 'Dollar Bank', category: 'bank', verified_numbers: ['+18002422265'], spoof_message: 'This IS the real Dollar Bank line. HANG UP and call the number on your card.' , contact_urls: ['https://dollar.bank/contact'], },
  { name: 'Independent Bank (Texas)', category: 'bank', verified_numbers: ['+18008343370'], spoof_message: 'This IS the real Independent Bank TX line. HANG UP and call the number on your card.' , contact_urls: ['https://www.southstatebank.com/global/help/contact-us'], },
  { name: 'Centennial Bank (Home BancShares)', category: 'bank', verified_numbers: ['+18883729788'], spoof_message: 'This IS the real Centennial Bank line. HANG UP and call the number on your card.' , contact_urls: ['https://www.my100bank.com/2023/06/13/telephone-banking/'], },
  { name: 'Enterprise Bank & Trust', category: 'bank', verified_numbers: ['+18772429492'], spoof_message: 'This IS the real Enterprise Bank & Trust line. HANG UP and call the number on your card.' , contact_urls: ['https://www.enterprisebank.com/contact-us'], },
];

const numberIndex = new Map<string, SpoofTargetEntry>();
for (const target of HIGH_SPOOF_TARGETS) {
  for (const num of target.verified_numbers) {
    numberIndex.set(num, target);
  }
}

export function lookupHighSpoofTarget(e164: string): SpoofTargetEntry | null {
  return numberIndex.get(e164) ?? null;
}
