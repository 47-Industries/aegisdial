# Telnyx Migration — Twilio → Telnyx cutover map

Why: Telnyx voice ≈ $0.002/min vs Twilio ≈ $0.0085/min inbound (3–4x cheaper).
A call screener burns inbound minutes on every screened call, so the per-minute
gap is the dominant unit cost at scale. SMS and Number Lookup are also cheaper.

Strategy: additive provider switch behind `CALL_PROVIDER` env (`twilio` | `telnyx`).
Twilio code stays intact as fallback until Telnyx is verified live. No big-bang rip-out.

## Config (DONE — additive, safe, all optional)
Added to src/config.ts:
- TELNYX_API_KEY
- TELNYX_MESSAGING_PROFILE_ID, TELNYX_MESSAGING_FROM
- TELNYX_TEXML_APP_ID  (create in Telnyx portal — gates voice cutover)
- TELNYX_CONNECTION_ID, TELNYX_VOICE_WEBHOOK_BASE
- CALL_PROVIDER (default 'twilio')

## The four Twilio touchpoints and their Telnyx equivalents

1. Call Screener — src/services/callScreener.ts (437 lines), src/routes/callScreener.ts
   Twilio: `Twilio()` SDK; availablePhoneNumbers().local.list; incomingPhoneNumbers.create
           with voiceUrl → /twilio/voice/incoming; TwiML responses.
   Telnyx: POST /v2/available_phone_numbers (search) → POST /v2/number_orders (buy) →
           attach to TeXML Application (TELNYX_TEXML_APP_ID). Voice webhooks point at
           /telnyx/voice/* and return TeXML (Twilio-TwiML compatible — markup mostly
           ports 1:1: <Response>, <Say>, <Gather>, <Hangup>, <Dial>).
   DB note: screener_numbers.twilio_sid → keep column, store Telnyx number id; or add
            provider + provider_id columns (migration) so both can coexist during rollout.

2. Guardian-alert SMS — src/workers/guardianAlertEscalator.ts (line 147)
   Twilio: POST https://api.twilio.com/2010-04-01/Accounts/{SID}/Messages.json (Basic auth)
   Telnyx: POST https://api.telnyx.com/v2/messages  (Bearer TELNYX_API_KEY),
           body { from: TELNYX_MESSAGING_FROM, to, text, messaging_profile_id }.
   Lowest-risk first migration — pure REST swap, no TeXML.

3. Number Lookup / caller ID — src/services/phoneLookup.ts (618 lines), src/lib/phone.ts
   Twilio: Lookup v2 (gated by ENABLE_TWILIO_LOOKUP / TWILIO_LOOKUP).
   Telnyx: GET https://api.telnyx.com/v2/number_lookup/{e164}?type=carrier  (Bearer).
           Maps carrier name + line type; caller-name (CNAM) via type=caller-name.

4. Env templates — .env.example, .env.production.template: add TELNYX_* keys.

## Sequence (mechanical once account + key exist)
1. SMS escalator → Telnyx (testable immediately with key + one number).
2. Number Lookup → Telnyx (testable immediately).
3. Voice screener → Telnyx TeXML (needs TELNYX_TEXML_APP_ID + ordered number;
   this is the piece that must be built/verified against the LIVE API, because a
   wrong webhook wiring = dropped calls, and that's grandma's call. Do not fake it.)
4. Flip CALL_PROVIDER=telnyx per-env, watch logs, then retire Twilio vars.

## Gated on (Josiah)
- Telnyx account (post-incorporation / bank).
- TELNYX_API_KEY, a Messaging Profile, a TeXML Application, ≥1 ordered number.
Drop those into Railway env → flip CALL_PROVIDER → live. No further code scramble.
