// App-wide constants that point at AegisDial's public-facing addresses.
//
// These live in ONE file because they all depend on the AegisDial domain.
// As of 2026-05-18 the domain is registered (GoDaddy) and the marketing +
// legal site is LIVE, served by the `aegisdial-web` Railway service through
// the custom domain `www.aegisdial.com`.
//
// Why `www.` and not the bare apex: DNS for aegisdial.com is hosted at
// GoDaddy, which cannot CNAME a root domain onto Railway. So Railway serves
// `www.aegisdial.com`, and the bare `aegisdial.com` is a GoDaddy 301 forward
// to it. That forward only redirects the root — it does NOT preserve paths
// (`aegisdial.com/terms` 404s). Every deep link below therefore uses the
// `www.` host directly; only typed-in bare-domain visits rely on the forward.
//
// Still pending: `support@aegisdial.com` needs MX records before mail sent
// to it is delivered — composing a message works, delivery does not yet.

/// Support inbox. Surfaced in Settings, the paywall, and About.
const String kSupportEmail = 'support@aegisdial.com';

/// Default subject line pre-filled when the user taps to email support.
const String kSupportEmailSubject = 'AegisDial support request';

/// Public legal documents. Mentioned in the auth screen's Terms /
/// Privacy disclosures and linked from Settings. Uses the `www.` host —
/// the bare-apex forward does not preserve these sub-paths.
const String kLegalTermsUrl = 'https://www.aegisdial.com/terms';
const String kLegalPrivacyUrl = 'https://www.aegisdial.com/privacy';

/// Marketing site root — used by any "learn more" affordance.
const String kMarketingUrl = 'https://www.aegisdial.com';
