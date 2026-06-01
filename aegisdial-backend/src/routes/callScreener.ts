/**
 * Call Screener routes.
 *
 * Two groups:
 * 1. User-facing (JWT-authed) — provision numbers, get status, view history
 * 2. Twilio webhooks (signature-validated) — incoming call, gather result, status
 */
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { requireAppUser, requireProTier } from '../lib/auth.js';
import { query } from '../lib/db.js';
import { emitMetric } from '../lib/observability.js';
import {
  provisionNumber,
  releaseNumber,
  getActiveNumber,
  findUserByScreenerNumber,
  createScreenedCall,
  updateScreenedCall,
  getScreenedCalls,
  analyzeTranscript,
  buildGreetingTwiml,
  buildForwardTwiml,
  buildRejectTwiml,
  buildVoicemailTwiml,
} from '../services/callScreener.js';

export async function callScreenerRoutes(app: FastifyInstance) {
  // ── Feature gate ─────────────────────────────────────────────────────
  if (!config.TWILIO_CALL_SCREENER_ENABLED) {
    // Register stubs that return 501 so the iOS client gets a clean error
    app.post('/v1/call-screener/provision', async (_, reply) => {
      reply.code(501).send({ error: 'call_screener_not_enabled' });
    });
    app.delete('/v1/call-screener/number', async (_, reply) => {
      reply.code(501).send({ error: 'call_screener_not_enabled' });
    });
    app.get('/v1/call-screener/status', async (_, reply) => {
      reply.code(501).send({ error: 'call_screener_not_enabled' });
    });
    app.get('/v1/call-screener/history', async (_, reply) => {
      reply.code(501).send({ error: 'call_screener_not_enabled' });
    });
    return;
  }

  const webhookBase = config.TWILIO_VOICE_WEBHOOK_BASE ?? '';

  // ═══════════════════════════════════════════════════════════════════════
  // USER-FACING ROUTES (JWT auth)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * POST /v1/call-screener/provision
   * Provision a Twilio number for this Pro user.
   */
  app.post('/v1/call-screener/provision', {
    preHandler: [requireAppUser, requireProTier],
  }, async (req, reply) => {
    try {
      const number = await provisionNumber(req.appUser!.id);

      // Build carrier forwarding codes for the user
      const fwd = number.phoneE164;
      const setupCodes = {
        // Forward unanswered calls (after ~15s ring)
        forwardUnanswered: `*61*${fwd}#`,
        // Forward when line is busy
        forwardBusy: `*67*${fwd}#`,
        // Forward when unreachable (airplane mode, dead battery)
        forwardUnreachable: `*62*${fwd}#`,
        // Disable all conditional forwarding
        disableAll: '##004#',
      };

      reply.send({
        number: {
          phone: number.phoneE164,
          provisioned: true,
        },
        setup_codes: setupCodes,
        instructions: [
          `Open your Phone app and dial: ${setupCodes.forwardUnanswered}`,
          `Then dial: ${setupCodes.forwardBusy}`,
          `Then dial: ${setupCodes.forwardUnreachable}`,
          'Each code should show a confirmation message.',
          'Calls you don\'t answer will now be screened by AegisDial AI.',
        ],
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'provision_failed';
      reply.code(500).send({ error: msg });
    }
  });

  /**
   * DELETE /v1/call-screener/number
   * Release the user's screener number and stop screening.
   */
  app.delete('/v1/call-screener/number', {
    preHandler: [requireAppUser, requireProTier],
  }, async (req, reply) => {
    const released = await releaseNumber(req.appUser!.id);
    reply.send({
      released,
      disable_instructions: [
        'Open your Phone app and dial: ##004#',
        'This disables all conditional call forwarding.',
      ],
    });
  });

  /**
   * GET /v1/call-screener/status
   * Get current screener status — number, setup state, stats.
   */
  app.get('/v1/call-screener/status', {
    preHandler: [requireAppUser, requireProTier],
  }, async (req, reply) => {
    const number = await getActiveNumber(req.appUser!.id);

    // Count recent screened calls
    const statsResult = await query(
      `SELECT
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE verdict = 'scam') AS blocked,
         COUNT(*) FILTER (WHERE verdict = 'safe') AS passed
       FROM screened_calls
       WHERE user_id = $1 AND created_at > now() - interval '30 days'`,
      [req.appUser!.id],
    );
    const stats = statsResult.rows[0];

    if (!number) {
      reply.send({
        active: false,
        number: null,
        setup_codes: null,
        stats_30d: { total: 0, blocked: 0, passed: 0 },
      });
      return;
    }

    const fwd = number.phoneE164;
    reply.send({
      active: true,
      number: { phone: number.phoneE164, since: number.createdAt },
      setup_codes: {
        forwardUnanswered: `*61*${fwd}#`,
        forwardBusy: `*67*${fwd}#`,
        forwardUnreachable: `*62*${fwd}#`,
        disableAll: '##004#',
      },
      stats_30d: {
        total: Number(stats.total),
        blocked: Number(stats.blocked),
        passed: Number(stats.passed),
      },
    });
  });

  /**
   * GET /v1/call-screener/history
   * Recent screened calls with verdicts.
   */
  app.get('/v1/call-screener/history', {
    preHandler: [requireAppUser, requireProTier],
  }, async (req, reply) => {
    const calls = await getScreenedCalls(req.appUser!.id, 50);
    reply.send({ calls });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // TWILIO WEBHOOK ROUTES (no JWT — validated by Twilio signature)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * POST /twilio/voice/incoming
   * Twilio hits this when a call arrives at a screener number.
   * Returns TwiML that greets the caller and gathers their speech.
   */
  app.post('/twilio/voice/incoming', async (req, reply) => {
    const body = req.body as Record<string, string>;
    const toNumber = body.To ?? '';
    const fromNumber = body.From ?? '';
    const callSid = body.CallSid ?? '';

    void emitMetric('call_screener.incoming_call');

    // Find which user this number belongs to
    const owner = await findUserByScreenerNumber(toNumber);
    if (!owner) {
      // Unknown number — shouldn't happen but handle gracefully
      reply.type('text/xml').send(buildRejectTwiml());
      return;
    }

    // Create the screened call record
    const callId = await createScreenedCall({
      userId: owner.userId,
      twilioCallSid: callSid,
      fromE164: fromNumber,
      toE164: toNumber,
    });

    // Return greeting TwiML — asks caller to identify themselves
    reply.type('text/xml').send(buildGreetingTwiml(callId, webhookBase));
  });

  /**
   * POST /twilio/voice/gather-result
   * Twilio hits this after the caller responds to the greeting.
   * We analyze their speech and decide: forward, block, or voicemail.
   */
  app.post('/twilio/voice/gather-result', async (req, reply) => {
    const body = req.body as Record<string, string>;
    const qs = req.query as Record<string, string>;
    const callId = Number(qs.callId);
    const speechResult = body.SpeechResult ?? '';

    if (!callId || !speechResult) {
      // No speech captured — send to voicemail
      reply.type('text/xml').send(buildVoicemailTwiml(callId, webhookBase));
      return;
    }

    // Analyze the caller's response using the scam detection pipeline
    const analysis = analyzeTranscript(speechResult);

    // Extract caller info from their response
    const callerName = extractCallerName(speechResult);
    const callerPurpose = speechResult.length > 200
      ? speechResult.substring(0, 197) + '...'
      : speechResult;

    // Update the call record
    await updateScreenedCall(callId, {
      transcript: speechResult,
      riskScore: analysis.riskScore,
      riskLevel: analysis.riskLevel,
      scamType: analysis.triggeredCategories[0] ?? undefined,
      callerName: callerName ?? undefined,
      callerPurpose: callerPurpose ?? undefined,
    });

    void emitMetric('call_screener.analyzed', {
      risk_level: analysis.riskLevel,
      is_scam: String(analysis.isScam),
    });

    if (analysis.isScam) {
      // Block the scam call
      await updateScreenedCall(callId, {
        verdict: 'scam',
        summary: analysis.summary,
      });

      // Send push notification about blocked scam
      void sendScreenerPush(callId, 'scam', analysis.summary);

      reply.type('text/xml').send(buildRejectTwiml());
      return;
    }

    if (analysis.riskScore < 25) {
      // Low risk — look up the user's real number and forward
      const userPhone = await getUserPhone(callId);
      if (userPhone) {
        await updateScreenedCall(callId, {
          verdict: 'safe',
          summary: analysis.summary,
          forwarded: true,
        });

        // Send push: "John from FedEx is calling about a delivery"
        void sendScreenerPush(callId, 'safe', `${callerName ?? 'Someone'} is calling: ${callerPurpose}`);

        reply.type('text/xml').send(buildForwardTwiml(userPhone));
        return;
      }
    }

    // Ambiguous — send to voicemail and let user decide
    await updateScreenedCall(callId, {
      verdict: 'unknown',
      summary: analysis.summary,
    });

    void sendScreenerPush(callId, 'unknown', `Screened call from ${body.From}: ${analysis.summary}`);

    reply.type('text/xml').send(buildVoicemailTwiml(callId, webhookBase));
  });

  /**
   * POST /twilio/voice/status
   * Call status callback — updates duration and end time.
   */
  app.post('/twilio/voice/status', async (req) => {
    const body = req.body as Record<string, string>;
    const callSid = body.CallSid ?? '';
    const duration = parseInt(body.CallDuration ?? '0', 10);
    const status = body.CallStatus ?? '';

    if (status === 'completed' || status === 'no-answer' || status === 'busy' || status === 'failed') {
      const result = await query(
        `SELECT id FROM screened_calls WHERE twilio_call_sid = $1`,
        [callSid],
      );
      if (result.rows.length > 0) {
        await updateScreenedCall(result.rows[0].id, {
          endedAt: new Date(),
          durationSecs: duration,
        });
      }
    }
  });

  /**
   * POST /twilio/voice/recording-done
   * Called when a voicemail recording finishes.
   */
  app.post('/twilio/voice/recording-done', async (_req, reply) => {
    // Acknowledge — transcription comes in a separate callback
    const twiml = '<Response><Hangup/></Response>';
    reply.type('text/xml').send(twiml);
  });

  /**
   * POST /twilio/voice/recording-transcription
   * Called when Twilio finishes transcribing a voicemail.
   */
  app.post('/twilio/voice/recording-transcription', async (req) => {
    const body = req.body as Record<string, string>;
    const qs = req.query as Record<string, string>;
    const callId = Number(qs.callId);
    const transcriptionText = body.TranscriptionText ?? '';

    if (callId && transcriptionText) {
      // Re-analyze the full voicemail transcription
      const analysis = analyzeTranscript(transcriptionText);
      await updateScreenedCall(callId, {
        transcript: transcriptionText,
        riskScore: analysis.riskScore,
        riskLevel: analysis.riskLevel,
        verdict: analysis.isScam ? 'scam' : 'safe',
        summary: analysis.summary,
      });
    }
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────

function extractCallerName(speech: string): string | null {
  // Simple heuristic: look for "my name is X" or "this is X" patterns
  const patterns = [
    /my name is ([A-Z][a-z]+(?: [A-Z][a-z]+)?)/i,
    /this is ([A-Z][a-z]+(?: [A-Z][a-z]+)?)/i,
    /i'm ([A-Z][a-z]+(?: [A-Z][a-z]+)?)/i,
    /(?:^|\. )([A-Z][a-z]+) (?:here|calling|from)/i,
  ];
  for (const p of patterns) {
    const m = speech.match(p);
    if (m?.[1]) return m[1];
  }
  return null;
}

async function getUserPhone(callId: number): Promise<string | null> {
  // Look up the user's phone number from their auth record
  const result = await query(
    `SELECT u.phone_e164
     FROM screened_calls sc
     JOIN users u ON u.id = sc.user_id
     WHERE sc.id = $1`,
    [callId],
  );
  return result.rows[0]?.phone_e164 ?? null;
}

async function sendScreenerPush(
  callId: number,
  verdict: string,
  summary: string,
): Promise<void> {
  try {
    // Get the user ID for this call
    const callResult = await query(
      `SELECT user_id, from_e164 FROM screened_calls WHERE id = $1`,
      [callId],
    );
    if (callResult.rows.length === 0) return;

    const { user_id: userId, from_e164: fromNumber } = callResult.rows[0];

    // Insert into guardian_alerts so the push dispatcher picks it up
    await query(
      `INSERT INTO guardian_alerts
         (subject_user_id, guardian_user_id, kind, severity, title, body, payload)
       VALUES ($1, $1, $2, $3, $4, $5, $6)`,
      [
        userId,
        'call_screener',
        verdict === 'scam' ? 'critical' : 'info',
        verdict === 'scam'
          ? `Scam call blocked from ${fromNumber}`
          : `Screened call from ${fromNumber}`,
        summary,
        JSON.stringify({ call_id: callId, verdict, from: fromNumber }),
      ],
    );

    await updateScreenedCall(callId, { pushSent: true });
    void emitMetric('call_screener.push_sent', { verdict });
  } catch {
    // Best-effort push
  }
}
