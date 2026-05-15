// App-wide constants that point at AegisDial's public-facing addresses.
//
// These live in ONE file because they all depend on the `aegisdial.com`
// domain, which (as of 2026-05-14) is not yet registered. When it goes
// live, this is the single file to touch — every screen reads from here.
//
// Until the domain resolves:
//   - kSupportEmail mail composes fine, but the message bounces (no MX).
//   - kLegalTermsUrl / kLegalPrivacyUrl 404 in a browser.
// Both are correct values that start working the moment Cloudflare
// registration + DNS land — no code change needed at that point.
//
// The legal docs are ALSO live right now on the Railway web service
// (aegisdial-web-production.up.railway.app/{terms,privacy}). We don't
// point at the Railway URL because shipping a long *.up.railway.app
// string into a TestFlight build looks unfinished; the 5-minute domain
// registration is the right fix.

/// Support inbox. Surfaced in Settings, the paywall, and About.
const String kSupportEmail = 'support@aegisdial.com';

/// Default subject line pre-filled when the user taps to email support.
const String kSupportEmailSubject = 'AegisDial support request';

/// Public legal documents. Mentioned in the auth screen's Terms /
/// Privacy disclosures and linked from Settings.
const String kLegalTermsUrl = 'https://aegisdial.com/terms';
const String kLegalPrivacyUrl = 'https://aegisdial.com/privacy';

/// Marketing site root — used by any "learn more" affordance.
const String kMarketingUrl = 'https://aegisdial.com';
