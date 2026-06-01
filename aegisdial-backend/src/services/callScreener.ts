/**
 * Call Screener — Twilio Programmable Voice integration.
 *
 * Provisions a US local phone number per Pro user. When a call forwards
 * to that number (via carrier conditional forwarding), the AI assistant
 * answers, greets the caller, transcribes the conversation, classifies
 * scam intent using the existing Live Shield pipeline, and either blocks
 * or forwards the call back to the user with a push summary.
 */
import Twilio from 'twilio';
import { config } from '../config.js';
import { query } from '../lib/db.js';
import { encryptString } from '../lib/crypto.js';
import { detectPhrases } from '../lib/scamPhrases.js';
import { scoreHits } from './liveShield.js';
import { emitMetric } from '../lib/observability.js';

// ── Twilio client (lazy init) ──────────────────────────────────────────

let _client: Twilio.Twilio | null = null;

function getTwilio(): Twilio.Twilio {
  if (_client) return _client;
  if (!config.TWILIO_ACCOUNT_SID || !config.TWILIO_AUTH_TOKEN) {
    throw new Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN required for Call Screener');
  }
  _client = Twilio(config.TWILIO_ACCOUNT_SID, config.TWILIO_AUTH_TOKEN);
  return _client;
}

// ── Number provisioning ────────────────────────────────────────────────

export interface ScreenerNumber {
  id: number;
  userId: string;
  twilioSid: string;
  phoneE164: string;
  active: boolean;
  createdAt: string;
}

/**
 * Provision a new US local Twilio number for this user. Sets the voice
 * webhook to our /twilio/voice/incoming endpoint so Twilio routes
 * forwarded calls to our AI screener.
 */
export async function provisionNumber(userId: string): Promise<ScreenerNumber> {
  const twilio = getTwilio();
  const webhookBase = config.TWILIO_VOICE_WEBHOOK_BASE;
  if (!webhookBase) throw new Error('TWILIO_VOICE_WEBHOOK_BASE not configured');

  // Check if user already has an active number
  const existing = await query(
    `SELECT id, user_id, twilio_sid, phone_e164, active, created_at
     FROM screener_numbers WHERE user_id = $1 AND active = true`,
    [userId],
  );
  if (existing.rows.length > 0) {
    const row = existing.rows[0];
    return {
      id: row.id,
      userId: row.user_id,
      twilioSid: row.twilio_sid,
      phoneE164: row.phone_e164,
      active: row.active,
      createdAt: row.created_at,
    };
  }

  // Search for available US local numbers
  const available = await twilio.availablePhoneNumbers('US')
    .local.list({ limit: 1, voiceEnabled: true, smsEnabled: false });

  if (available.length === 0) {
    throw new Error('No available Twilio numbers — try again later');
  }

  // Purchase and configure the number
  const purchased = await twilio.incomingPhoneNumbers.create({
    phoneNumber: available[0].phoneNumber,
    voiceUrl: `${webhookBase}/twilio/voice/incoming`,
    voiceMethod: 'POST',
    statusCallback: `${webhookBase}/twilio/voice/status`,
    statusCallbackMethod: 'POST',
    friendlyName: `AegisDial Screener — user ${userId}`,
  });

  // Persist
  const result = await query(
    `INSERT INTO screener_numbers (user_id, twilio_sid, phone_e164)
     VALUES ($1, $2, $3)
     RETURNING id, user_id, twilio_sid, phone_e164, active, created_at`,
    [userId, purchased.sid, purchased.phoneNumber],
  );

  void emitMetric('call_screener.number_provisioned');
  const row = result.rows[0];
  return {
    id: row.id,
    userId: row.user_id,
    twilioSid: row.twilio_sid,
    phoneE164: row.phone_e164,
    active: row.active,
    createdAt: row.created_at,
  };
}

/**
 * Release a user's Twilio screener number.
 */
export async function releaseNumber(userId: string): Promise<boolean> {
  const existing = await query(
    `SELECT twilio_sid FROM screener_numbers WHERE user_id = $1 AND active = true`,
    [userId],
  );
  if (existing.rows.length === 0) return false;

  const twilioSid = existing.rows[0].twilio_sid;
  try {
    await getTwilio().incomingPhoneNumbers(twilioSid).remove();
  } catch (e) {
    // Best-effort — number may already be released on Twilio's side
  }

  await query(
    `UPDATE screener_numbers SET active = false, released_at = now()
     WHERE user_id = $1 AND active = true`,
    [userId],
  );

  void emitMetric('call_screener.number_released');
  return true;
}

/**
 * Get user's active screener number, if any.
 */
export async function getActiveNumber(userId: string): Promise<ScreenerNumber | null> {
  const result = await query(
    `SELECT id, user_id, twilio_sid, phone_e164, active, created_at
     FROM screener_numbers WHERE user_id = $1 AND active = true`,
    [userId],
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    id: row.id,
    userId: row.user_id,
    twilioSid: row.twilio_sid,
    phoneE164: row.phone_e164,
    active: row.active,
    createdAt: row.created_at,
  };
}

// ── Lookup user by screener number ─────────────────────────────────────

/**
 * Find which user owns a screener number (for incoming call routing).
 */
export async function findUserByScreenerNumber(
  toE164: string,
): Promise<{ userId: string; phoneE164: string } | null> {
  const result = await query(
    `SELECT user_id, phone_e164 FROM screener_numbers
     WHERE phone_e164 = $1 AND active = true`,
    [toE164],
  );
  if (result.rows.length === 0) return null;
  return {
    userId: result.rows[0].user_id,
    phoneE164: result.rows[0].phone_e164,
  };
}

// ── Call record management ─────────────────────────────────────────────

export interface ScreenedCall {
  id: number;
  userId: string;
  twilioCallSid: string;
  fromE164: string;
  toE164: string;
  startedAt: string;
  endedAt: string | null;
  durationSecs: number | null;
  riskScore: number | null;
  riskLevel: string | null;
  scamType: string | null;
  verdict: string;
  summary: string | null;
  forwarded: boolean;
  callerName: string | null;
  callerPurpose: string | null;
  createdAt: string;
}

/**
 * Create a screened call record when an incoming call arrives.
 */
export async function createScreenedCall(args: {
  userId: string;
  twilioCallSid: string;
  fromE164: string;
  toE164: string;
}): Promise<number> {
  const result = await query(
    `INSERT INTO screened_calls (user_id, twilio_call_sid, from_e164, to_e164)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [args.userId, args.twilioCallSid, args.fromE164, args.toE164],
  );
  return result.rows[0].id;
}

/**
 * Update a screened call with analysis results.
 */
export async function updateScreenedCall(
  callId: number,
  update: {
    transcript?: string;
    riskScore?: number;
    riskLevel?: string;
    scamType?: string;
    verdict?: string;
    summary?: string;
    callerName?: string;
    callerPurpose?: string;
    forwarded?: boolean;
    endedAt?: Date;
    durationSecs?: number;
    pushSent?: boolean;
  },
): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [];
  let i = 1;

  if (update.transcript !== undefined) {
    sets.push(`transcript_ct = $${i++}`);
    values.push(encryptString(update.transcript));
  }
  if (update.riskScore !== undefined) { sets.push(`risk_score = $${i++}`); values.push(update.riskScore); }
  if (update.riskLevel !== undefined) { sets.push(`risk_level = $${i++}`); values.push(update.riskLevel); }
  if (update.scamType !== undefined) { sets.push(`scam_type = $${i++}`); values.push(update.scamType); }
  if (update.verdict !== undefined) { sets.push(`verdict = $${i++}`); values.push(update.verdict); }
  if (update.summary !== undefined) { sets.push(`summary = $${i++}`); values.push(update.summary); }
  if (update.callerName !== undefined) { sets.push(`caller_name = $${i++}`); values.push(update.callerName); }
  if (update.callerPurpose !== undefined) { sets.push(`caller_purpose = $${i++}`); values.push(update.callerPurpose); }
  if (update.forwarded !== undefined) {
    sets.push(`forwarded = $${i++}`);
    values.push(update.forwarded);
    if (update.forwarded) { sets.push(`forwarded_at = now()`); }
  }
  if (update.endedAt !== undefined) { sets.push(`ended_at = $${i++}`); values.push(update.endedAt); }
  if (update.durationSecs !== undefined) { sets.push(`duration_secs = $${i++}`); values.push(update.durationSecs); }
  if (update.pushSent !== undefined) {
    sets.push(`push_sent = $${i++}`);
    values.push(update.pushSent);
    if (update.pushSent) { sets.push(`push_sent_at = now()`); }
  }

  if (sets.length === 0) return;
  values.push(callId);
  await query(
    `UPDATE screened_calls SET ${sets.join(', ')} WHERE id = $${i}`,
    values,
  );
}

/**
 * Get recent screened calls for a user.
 */
export async function getScreenedCalls(
  userId: string,
  limit = 50,
): Promise<ScreenedCall[]> {
  const result = await query(
    `SELECT id, user_id, twilio_call_sid, from_e164, to_e164,
            started_at, ended_at, duration_secs,
            risk_score, risk_level, scam_type, verdict,
            summary, forwarded, caller_name, caller_purpose, created_at
     FROM screened_calls
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [userId, limit],
  );
  return result.rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    twilioCallSid: r.twilio_call_sid,
    fromE164: r.from_e164,
    toE164: r.to_e164,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    durationSecs: r.duration_secs,
    riskScore: r.risk_score,
    riskLevel: r.risk_level,
    scamType: r.scam_type,
    verdict: r.verdict,
    summary: r.summary,
    forwarded: r.forwarded,
    callerName: r.caller_name,
    callerPurpose: r.caller_purpose,
    createdAt: r.created_at,
  }));
}

// ── Scam analysis (reuses Live Shield pipeline) ────────────────────────

export interface ScreenerAnalysis {
  riskScore: number;
  riskLevel: string;
  triggeredCategories: string[];
  isScam: boolean;
  summary: string;
}

/**
 * Analyze a caller's transcript using the existing scam phrase detection
 * pipeline. Returns risk score and a human-readable summary.
 */
export function analyzeTranscript(transcript: string): ScreenerAnalysis {
  const hits = detectPhrases(transcript);
  const snapshot = scoreHits(hits);

  const isScam = snapshot.risk_score >= 50;
  const topCategories = snapshot.triggered_categories.slice(0, 3);

  let summary: string;
  if (snapshot.risk_score < 25) {
    summary = 'Caller appears legitimate. No scam indicators detected.';
  } else if (snapshot.risk_score < 50) {
    summary = `Some suspicious language detected (${topCategories.join(', ')}). Use caution.`;
  } else if (snapshot.risk_score < 75) {
    summary = `Likely scam call — ${topCategories.join(', ')}. Call was blocked.`;
  } else {
    summary = `High-confidence scam — ${topCategories.join(', ')}. Call was blocked and logged.`;
  }

  return {
    riskScore: snapshot.risk_score,
    riskLevel: snapshot.risk_level,
    triggeredCategories: snapshot.triggered_categories,
    isScam,
    summary,
  };
}

// ── TwiML builders ─────────────────────────────────────────────────────

const { VoiceResponse } = Twilio.twiml;

/**
 * Build TwiML for the initial call greeting. The AI asks the caller
 * to identify themselves and state their purpose.
 */
export function buildGreetingTwiml(callId: number, webhookBase: string): string {
  const twiml = new VoiceResponse();

  // Short pause, then greeting
  twiml.pause({ length: 1 });
  const gather = twiml.gather({
    input: ['speech'],
    action: `${webhookBase}/twilio/voice/gather-result?callId=${callId}`,
    method: 'POST',
    speechTimeout: 'auto',
    language: 'en-US',
    timeout: 8,
  });
  gather.say(
    { voice: 'Polly.Matthew', language: 'en-US' },
    "Hi, you've reached a number protected by AegisDial. " +
    "Please state your name and the reason for your call, " +
    "and we'll connect you right away.",
  );

  // Fallback if caller doesn't speak
  twiml.say(
    { voice: 'Polly.Matthew', language: 'en-US' },
    "I didn't catch that. This call will be sent to voicemail. Goodbye.",
  );
  twiml.hangup();

  return twiml.toString();
}

/**
 * Build TwiML to forward a screened call back to the user's real number.
 * Uses the user's phone (fetched from DB) as the dial target.
 */
export function buildForwardTwiml(userPhoneE164: string): string {
  const twiml = new VoiceResponse();
  twiml.say(
    { voice: 'Polly.Matthew', language: 'en-US' },
    "Connecting you now.",
  );
  twiml.dial(
    { callerId: userPhoneE164, timeout: 25 },
    userPhoneE164,
  );
  return twiml.toString();
}

/**
 * Build TwiML to reject a scam call.
 */
export function buildRejectTwiml(): string {
  const twiml = new VoiceResponse();
  twiml.say(
    { voice: 'Polly.Matthew', language: 'en-US' },
    "This call has been identified as potentially fraudulent and will not be connected. Goodbye.",
  );
  twiml.hangup();
  return twiml.toString();
}

/**
 * Build TwiML for unknown/ambiguous calls — send to voicemail-style recording.
 */
export function buildVoicemailTwiml(callId: number, webhookBase: string): string {
  const twiml = new VoiceResponse();
  twiml.say(
    { voice: 'Polly.Matthew', language: 'en-US' },
    "The person you're calling is unavailable right now. " +
    "Please leave a brief message after the tone.",
  );
  twiml.record({
    maxLength: 120,
    action: `${webhookBase}/twilio/voice/recording-done?callId=${callId}`,
    transcribe: true,
    transcribeCallback: `${webhookBase}/twilio/voice/recording-transcription?callId=${callId}`,
  });
  return twiml.toString();
}
