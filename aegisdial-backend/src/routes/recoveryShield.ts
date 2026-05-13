import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAppUser, requireProTier } from '../lib/auth.js';
import { readMaybeEncrypted } from '../lib/crypto.js';
import { emitMetric, captureError } from '../lib/observability.js';
import { callLLM } from '../lib/llm.js';
import { query } from '../lib/db.js';
import {
  hasRecoveryPlus,
  purchaseRecoveryPlus,
  RECOVERY_PLUS_PRICE_CENTS,
  InvalidPriceError,
  InvalidProductError,
  InvalidBundleError,
  ReceiptVerificationError,
} from '../services/recovery/recoveryPlusEntitlement.js';
import {
  startWireTraceCase,
  advanceWireTraceCase,
  generateDisputeLetter,
  getWireTraceCase,
  RecoveryPlusRequiredError as WireRecoveryPlusRequiredError,
  InvalidStateTransitionError as WireInvalidStateTransitionError,
  NotFoundError as WireNotFoundError,
} from '../services/recovery/wireTraceAgent.js';
import {
  startCryptoTraceCase,
  runTraceHops,
  generateExchangePetition,
  advanceCryptoTraceCase,
  getCryptoTraceCase,
  RecoveryPlusRequiredError as CryptoRecoveryPlusRequiredError,
  CryptoTraceCaseNotFoundError,
  InvalidStateError as CryptoInvalidStateError,
  type ChainName,
} from '../services/recovery/cryptoTraceAgent.js';
import {
  generateLegalPacket,
  listLegalDocuments,
  getLegalDocument,
  DisclaimerNotAcknowledgedError,
  RecoveryPlusRequiredError as DocRecoveryPlusRequiredError,
  type LegalDocKind,
} from '../services/recovery/legalPacketGenerator.js';
import {
  listSpecialistsFor,
  getSpecialist,
  createReferral,
  listReferralsForUser,
  RecoveryPlusRequiredError as MarketRecoveryPlusRequiredError,
  SpecialistNotAvailableError,
  RecoverySessionNotFoundError,
} from '../services/recovery/specialistMarketplace.js';

// Recovery Shield — /v1/recovery/* Pro+Plus surface (R-P5).
//
// This file is the user-facing API for everything Recovery Plus —
// the $249 per-session unlock layer that sits on top of the basic
// Recovery Concierge in src/routes/recovery.ts. Three concerns wired
// in one route table:
//
//   1. Plus purchase / status (Pro-gated, NOT Plus-gated —
//      purchasing IS how Plus is acquired).
//   2. Trace cases — wire-recall + crypto-trace (Plus-gated end-to-end).
//   3. Legal packet — multi-doc orchestrator (Plus-gated for
//      generation; reading your own doc list is Pro-gated only so
//      paying-but-not-Plus users can preview the surface).
//   4. Specialist marketplace — browse-is-Pro, refer-is-Plus.
//
// PRO vs. PLUS GATE STRATEGY:
//
//   `requireRecoveryPlus(extractSessionId)` is a higher-order
//   preHandler factory. The extractor pulls recovery_session_id from
//   whichever bag (body / params / query) the route uses, then we run
//   hasRecoveryPlus(user_id, session_id). 402 on miss. The pattern
//   stays composable with the per-route requireAppUser +
//   requireProTier chain because the Plus gate ALWAYS implies the
//   Pro gate — Pro is a hard prerequisite for buying Plus at all.
//
//   For routes where the session_id comes from a case_id (the
//   trace/wire/:case_id/* paths), the extractor can't resolve the
//   session id without a DB read. We resolve it inside the route
//   handler instead (look up the case, then check Plus). The
//   middleware path only covers the routes where session_id rides on
//   the request bag.
//
// CROSS-USER POSTURE:
//
//   Every service-layer call is user_id-scoped. The service layer
//   returns null / throws NotFoundError on cross-user access; the
//   route layer maps both to a uniform 404 (we don't distinguish
//   "doesn't exist" from "belongs to someone else" — same shape, no
//   information leakage).
//
// DECRYPTION POSTURE:
//
//   Trace case bodies, dispute letters, exchange petitions, and
//   legal-doc body_markdown all sit at rest as envelope-encrypted
//   ciphertext (v1:<iv>:<tag>:<ct>). The service layer returns the
//   raw row; the route layer is the LAST hop before the wire — we
//   decrypt via readMaybeEncrypted() here so the iOS client receives
//   plaintext over TLS.
//
// RATE LIMITS (per user via userKeyedLimit, mirrors emailShield +
// identityShield):
//
//   POST plus/purchase: 5/min                  (IAP retry storm guard)
//   POST trace/wire | trace/crypto creation: 10/min
//   POST trace/*/advance: 30/min               (state-machine churn)
//   POST documents/generate: 5/min             (LLM cost defense)
//   POST trace/*/letter | trace/*/petition | trace/*/hops: 5/min  (LLM cost)
//   POST specialists/refer: 10/min
//   GET routes: 60/min
//
// The actual server.ts registration is deferred to final wiring;
// this file exports recoveryShieldRoutes as a FastifyPluginAsync
// ready to plug in.

// --------------------------------------------------------------------
// Zod schemas — strict-shape validation for every input bag
// --------------------------------------------------------------------

const UuidSchema = z.string().uuid();

// IAP receipt. The Apple JWS is up to a few kB; cap at 16 kB to defend
// against absurd-size receipt-replay payloads. The service layer also
// validates the JWS signature; this is a cheap pre-check.
const PlusPurchaseBodySchema = z.object({
  apple_receipt: z.string().min(32).max(16_384),
  apple_transaction_id: z.string().min(1).max(128),
  recovery_session_id: UuidSchema.optional(),
  purchase_amount_cents: z.number().int().positive(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
});

const PlusStatusQuerySchema = z.object({
  recovery_session_id: UuidSchema,
});

// Wire trace. wire_amount_cents arrives as a JSON number; BIGINT-safe
// values are accepted as long as they fit Number.MAX_SAFE_INTEGER
// (9e15 cents = $90 trillion — practical ceiling). The service layer
// coerces to bigint for pg's BIGINT param binding.
const WireTraceCreateBodySchema = z.object({
  source_bank: z.string().min(1).max(120),
  destination_account_hint: z.string().min(1).max(64).optional(),
  wire_amount_cents: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  wire_sent_at: z.string().datetime(),
  recovery_session_id: UuidSchema,
});

const WIRE_NEXT_STATES = [
  'letter_drafted',
  'user_sent',
  'bank_acknowledged',
  'recalled',
  'denied',
  'closed',
] as const;

const WireTraceAdvanceBodySchema = z.object({
  next_state: z.enum(WIRE_NEXT_STATES),
  bank_response_text: z.string().min(1).max(8192).optional(),
  recovery_session_id: UuidSchema,
});

const WireTraceLetterBodySchema = z.object({
  recovery_session_id: UuidSchema,
});

const CHAIN_NAMES = [
  'ethereum',
  'bitcoin',
  'tron',
  'polygon',
  'bsc',
  'solana',
  'arbitrum',
  'optimism',
  'base',
] as const satisfies readonly ChainName[];

const CryptoTraceCreateBodySchema = z.object({
  source_wallet: z.string().min(8).max(128),
  destination_wallet: z.string().min(8).max(128),
  chain: z.enum(CHAIN_NAMES),
  // Decimal string in chain base units — never coerced through Number.
  amount_native: z.string().regex(/^\d+(\.\d+)?$/).max(64),
  amount_usd_cents_at_send: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  recovery_session_id: UuidSchema,
});

const CryptoTraceHopsBodySchema = z.object({
  max_hops: z.number().int().positive().max(10).optional(),
  recovery_session_id: UuidSchema,
});

const CRYPTO_NEXT_STATES = [
  'tracing',
  'exchange_identified',
  'petition_drafted',
  'user_sent',
  'exchange_acked',
  'frozen',
  'denied',
  'closed',
] as const;

const CryptoTraceAdvanceBodySchema = z.object({
  next_state: z.enum(CRYPTO_NEXT_STATES),
  recovery_session_id: UuidSchema,
});

const CryptoTracePetitionBodySchema = z.object({
  recovery_session_id: UuidSchema,
});

const LEGAL_DOC_KINDS = [
  'ic3_complaint',
  'ftc_complaint',
  'cfpb_complaint',
  'state_ag_complaint',
  'affidavit',
  'demand_letter',
  'credit_freeze_request',
  'police_report_draft',
  'exchange_petition',
  'insurance_claim',
] as const satisfies readonly LegalDocKind[];

const DocumentsGenerateBodySchema = z.object({
  recovery_session_id: UuidSchema,
  doc_kinds: z.array(z.enum(LEGAL_DOC_KINDS)).min(1).max(10).optional(),
  // ISO-3166-2 (e.g., 'US-FL'). Loose-validated to subdivision pattern
  // because the table of accepted values lives in stateAgComplaintForms.ts
  // and we don't want this layer to drift out of sync with that.
  state_jurisdiction: z.string().regex(/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/).optional(),
  user_acknowledged_disclaimer: z.boolean(),
  case_facts: z.object({
    scam_type: z.string().min(1).max(128),
    amount_lost_cents: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    scam_actor_descriptor: z.string().max(512).optional(),
    scam_actor_contact: z.string().max(256).optional(),
    incident_date: z.string().datetime(),
    description_summary: z.string().max(4096).optional(),
  }),
});

const DocumentsListQuerySchema = z.object({
  recovery_session_id: UuidSchema.optional(),
});

const SPECIALIST_CATEGORIES = [
  'asset_recovery_attorney',
  'blockchain_forensics',
  'identity_restoration',
  'cyber_insurance_consult',
  'tax_professional_loss_writeoff',
] as const;

const SpecialistsListQuerySchema = z.object({
  category: z.enum(SPECIALIST_CATEGORIES).optional(),
  // ISO-3166-2 (loose) — exact set is data-driven in specialistMarketplace.
  jurisdiction: z.string().regex(/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/).optional(),
  // capabilities[] arrives as either repeated query params (?capabilities=x&capabilities=y)
  // or a comma-joined single param. Fastify normalizes the former into an
  // array; we accept both shapes and coerce to array.
  capabilities: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) => {
      if (v === undefined) return undefined;
      if (Array.isArray(v)) return v;
      // Single string — accept comma-split for convenience.
      return v.includes(',') ? v.split(',').map((s) => s.trim()).filter(Boolean) : [v];
    }),
  limit: z.coerce.number().int().positive().max(50).optional(),
});

const SpecialistReferBodySchema = z.object({
  specialist_id: UuidSchema,
  recovery_session_id: UuidSchema,
});

const ReferralsListQuerySchema = z.object({
  recovery_session_id: UuidSchema.optional(),
});

// --------------------------------------------------------------------
// userKeyedLimit — same idiom as emailShield + identityShield
// --------------------------------------------------------------------
//
// hook:'preHandler' so the limiter runs AFTER requireAppUser sets
// req.appUser (adversarial-review H1 — fastify-rate-limit defaults to
// onRequest which would key by IP, defeating user-scoped quota).
const userKeyedLimit = {
  hook: 'preHandler' as const,
  keyGenerator: (req: FastifyRequest) =>
    req.appUser?.id ? `user:${req.appUser.id}` : `ip:${req.ip}`,
};

// --------------------------------------------------------------------
// LLM wrapper for legalPacketGenerator
// --------------------------------------------------------------------
//
// legalPacketGenerator.ts ships with a `defaultLlmFn` that THROWS —
// the production wiring was deferred to the route layer (per its
// own comment). This file IS the route layer; we wire it here.
//
// Contract: the LegalDocKind prompt scaffolds instruct the model to
// return JSON `{ "body_markdown": "..." }`. callLLM returns plain text,
// so we parse before returning. A malformed model output (non-JSON, or
// JSON missing body_markdown) throws so the per-doc try/catch in
// generateLegalPacket surfaces it as a failure rather than an empty doc.
const legalPacketLlmFn = async (input: {
  system: string;
  user: string;
}): Promise<{ body_markdown: string }> => {
  const raw = await callLLM({
    system: input.system,
    user: input.user,
    maxTokens: 4096,
  });
  // Strip code fences a chatty model may emit despite the scaffold's
  // "no markdown code fences" instruction.
  const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/```$/g, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    throw new Error(`legalPacketLlmFn: model output not valid JSON: ${stripped.slice(0, 200)}`);
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { body_markdown?: unknown }).body_markdown !== 'string'
  ) {
    throw new Error('legalPacketLlmFn: response missing body_markdown field');
  }
  return { body_markdown: (parsed as { body_markdown: string }).body_markdown };
};

// --------------------------------------------------------------------
// requireRecoveryPlus — higher-order preHandler factory
// --------------------------------------------------------------------
//
// Composition contract: this preHandler is appended AFTER
// requireAppUser + requireProTier. It assumes req.appUser is populated
// and req.appUser.tier === 'pro'. (Belt-and-suspenders: if not, it
// surfaces the same 401/402 paths as the underlying middleware would.)
//
// The extractor pulls a recovery_session_id from the request bag of
// the caller's choice (body / params / query). UUID-shape is checked;
// a malformed value short-circuits to 400 before the entitlement
// query runs. This keeps the DB cold path off malformed-input traffic.
export function requireRecoveryPlus(
  extractSessionId: (req: FastifyRequest) => string | undefined,
): (req: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (req, reply) => {
    // Defense-in-depth chain. The route's preHandler array runs in
    // declaration order; this fn assumes [requireAppUser, requireProTier]
    // ran first. If either short-circuited, the reply is already sent
    // and Fastify won't invoke us — so these checks are belt-and-
    // suspenders for direct unit-test invocation paths.
    if (!req.appUser) {
      reply.code(401).send({ error: 'unauthorized' });
      return;
    }
    if (req.appUser.tier !== 'pro') {
      reply.code(402).send({
        error: 'subscription_required',
        tier: req.appUser.tier,
        message: 'Pro subscription required before Recovery Plus.',
      });
      return;
    }
    const sessionId = extractSessionId(req);
    if (!sessionId) {
      reply.code(400).send({
        error: 'invalid_body',
        message: 'recovery_session_id is required for Recovery Plus routes.',
      });
      return;
    }
    const uuidCheck = UuidSchema.safeParse(sessionId);
    if (!uuidCheck.success) {
      reply.code(400).send({ error: 'invalid_recovery_session_id' });
      return;
    }
    const entitled = await hasRecoveryPlus(req.appUser.id, uuidCheck.data);
    if (!entitled) {
      void emitMetric('recovery_shield.plus_gate_denied', {});
      reply.code(402).send({
        error: 'recovery_plus_required',
        message:
          'This action requires Recovery Plus. Purchase via /v1/recovery/plus/purchase.',
      });
      return;
    }
  };
}

// --------------------------------------------------------------------
// Small extractors — keep the route declarations dense
// --------------------------------------------------------------------

const sessionFromBody = (req: FastifyRequest): string | undefined => {
  const b = req.body as { recovery_session_id?: unknown } | undefined;
  return typeof b?.recovery_session_id === 'string' ? b.recovery_session_id : undefined;
};

const sessionFromQuery = (req: FastifyRequest): string | undefined => {
  const q = req.query as { recovery_session_id?: unknown } | undefined;
  return typeof q?.recovery_session_id === 'string' ? q.recovery_session_id : undefined;
};

// --------------------------------------------------------------------
// Row-to-DTO transforms — decrypt + camelCase as needed
// --------------------------------------------------------------------

interface WireTraceCaseDTO {
  id: string;
  recovery_session_id: string;
  source_bank: string;
  destination_account_hint: string | null;
  wire_amount_cents: string;
  wire_sent_at: string;
  state: string;
  dispute_letter_text: string | null;
  bank_response_text: string | null;
  state_changed_at: string;
  created_at: string;
}

function wireTraceCaseToDTO(row: {
  id: string;
  recovery_session_id: string;
  source_bank: string;
  destination_account_hint: string | null;
  wire_amount_cents: string;
  wire_sent_at: Date;
  state: string;
  dispute_letter_text: string | null;
  bank_response_text: string | null;
  state_changed_at: Date;
  created_at: Date;
}): WireTraceCaseDTO {
  return {
    id: row.id,
    recovery_session_id: row.recovery_session_id,
    source_bank: row.source_bank,
    destination_account_hint: readMaybeEncrypted(row.destination_account_hint),
    wire_amount_cents: String(row.wire_amount_cents),
    wire_sent_at: row.wire_sent_at.toISOString(),
    state: row.state,
    dispute_letter_text: readMaybeEncrypted(row.dispute_letter_text),
    bank_response_text: readMaybeEncrypted(row.bank_response_text),
    state_changed_at: row.state_changed_at.toISOString(),
    created_at: row.created_at.toISOString(),
  };
}

interface CryptoTraceCaseDTO {
  id: string;
  recovery_session_id: string;
  source_wallet: string;
  destination_wallet: string;
  chain: string;
  amount_native: string;
  amount_usd_cents_at_send: string;
  hops_analyzed: number;
  exchange_tagged: string | null;
  trace_report_jsonb: unknown;
  state: string;
  petition_text: string | null;
  state_changed_at: string;
  created_at: string;
}

function cryptoTraceCaseToDTO(row: {
  id: string;
  recovery_session_id: string;
  source_wallet: string;
  destination_wallet: string;
  chain: string;
  amount_native: string;
  amount_usd_cents_at_send: string;
  hops_analyzed: number;
  exchange_tagged: string | null;
  trace_report_jsonb: unknown;
  state: string;
  petition_text: string | null;
  state_changed_at: Date;
  created_at: Date;
}): CryptoTraceCaseDTO {
  return {
    id: row.id,
    recovery_session_id: row.recovery_session_id,
    source_wallet: row.source_wallet,
    destination_wallet: row.destination_wallet,
    chain: row.chain,
    amount_native: row.amount_native,
    amount_usd_cents_at_send: row.amount_usd_cents_at_send,
    hops_analyzed: row.hops_analyzed,
    exchange_tagged: row.exchange_tagged,
    trace_report_jsonb: row.trace_report_jsonb,
    state: row.state,
    petition_text: readMaybeEncrypted(row.petition_text),
    state_changed_at: row.state_changed_at.toISOString(),
    created_at: row.created_at.toISOString(),
  };
}

interface LegalDocumentDTO {
  id: string;
  recovery_session_id: string;
  doc_kind: string;
  state_jurisdiction: string | null;
  body_markdown: string | null;
  pdf_url: string | null;
  generated_at: string;
  user_acknowledged_disclaimer_at: string | null;
}

function legalDocumentToDTO(row: {
  id: string;
  recovery_session_id: string;
  doc_kind: string;
  state_jurisdiction: string | null;
  body_markdown: string;
  pdf_url: string | null;
  generated_at: Date;
  user_acknowledged_disclaimer_at: Date | null;
}): LegalDocumentDTO {
  return {
    id: row.id,
    recovery_session_id: row.recovery_session_id,
    doc_kind: row.doc_kind,
    state_jurisdiction: row.state_jurisdiction,
    body_markdown: readMaybeEncrypted(row.body_markdown),
    pdf_url: row.pdf_url,
    generated_at: row.generated_at.toISOString(),
    user_acknowledged_disclaimer_at:
      row.user_acknowledged_disclaimer_at?.toISOString() ?? null,
  };
}

// --------------------------------------------------------------------
// Route registration
// --------------------------------------------------------------------

export async function recoveryShieldRoutes(app: FastifyInstance): Promise<void> {
  // ================================================================
  // PLUS PURCHASE / STATUS — Pro-gated; NOT Plus-gated (purchasing
  // IS how Plus is acquired).
  // ================================================================

  // -------------------------------------------------------------
  // POST /v1/recovery/plus/purchase
  // -------------------------------------------------------------
  //
  // iOS StoreKit2 flow:
  //   1. Client completes the IAP for `recovery_plus_one_time` ($249).
  //   2. Client posts the signedTransactionInfo JWS here.
  //   3. We verify the JWS, cross-check product/bundle/price, and
  //      INSERT (idempotent on apple_transaction_id) into
  //      recovery_plus_purchases.
  //
  // Rate limit: 5/min per user — defends against IAP retry storms
  // from a flaky client without blocking legitimate retries.
  app.post(
    '/v1/recovery/plus/purchase',
    {
      preHandler: [requireAppUser, requireProTier],
      config: {
        rateLimit: { max: 5, timeWindow: '1 minute', ...userKeyedLimit },
      },
    },
    async (req, reply) => {
      const parsed = PlusPurchaseBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', details: parsed.error.flatten() });
      }
      if (parsed.data.purchase_amount_cents !== RECOVERY_PLUS_PRICE_CENTS) {
        // Fast-fail before the JWS verify path — same outcome as the
        // service-layer InvalidPriceError, just with cheaper failure.
        return reply.code(400).send({
          error: 'invalid_price',
          expected: RECOVERY_PLUS_PRICE_CENTS,
          got: parsed.data.purchase_amount_cents,
        });
      }
      const userId = req.appUser!.id;
      try {
        const result = await purchaseRecoveryPlus({
          user_id: userId,
          apple_receipt: parsed.data.apple_receipt,
          apple_transaction_id: parsed.data.apple_transaction_id,
          recovery_session_id: parsed.data.recovery_session_id,
          purchase_amount_cents: parsed.data.purchase_amount_cents,
          currency: parsed.data.currency,
        });
        // Cross-user replay guard (R-H3). When the service returns
        // is_new=false, the apple_transaction_id already exists in the
        // table. The service intentionally surfaces the canonical row
        // regardless of which user replayed it — the route is the
        // ownership gate. Re-fetch the row's user_id; if a different
        // user is replaying (stolen JWS / log leak / Apple-ID sharing
        // edge case), surface a 409 instead of leaking the original
        // purchase_id back to the wrong caller.
        if (!result.is_new) {
          const owner = await query<{ user_id: string }>(
            `SELECT user_id FROM recovery_plus_purchases WHERE id = $1`,
            [result.purchase_id],
          );
          const ownerId = owner.rows[0]?.user_id;
          if (ownerId && ownerId !== userId) {
            void emitMetric('recovery_shield.plus_purchase_cross_user_replay', {});
            return reply.code(409).send({
              error: 'transaction_id_already_used',
              message: 'This Apple transaction has already been redeemed.',
            });
          }
        }
        void emitMetric('recovery_shield.route_plus_purchase', {
          is_new: result.is_new,
        });
        return reply.code(result.is_new ? 201 : 200).send({
          purchase_id: result.purchase_id,
          entitled_session_id: result.entitled_session_id,
          is_new: result.is_new,
        });
      } catch (err) {
        if (err instanceof InvalidPriceError) {
          return reply.code(400).send({ error: 'invalid_price' });
        }
        if (err instanceof InvalidProductError) {
          return reply.code(400).send({ error: 'invalid_product' });
        }
        if (err instanceof InvalidBundleError) {
          return reply.code(400).send({ error: 'invalid_bundle' });
        }
        if (err instanceof ReceiptVerificationError) {
          return reply.code(400).send({ error: 'receipt_verification_failed' });
        }
        captureError(err, {
          component: 'recoveryShield.plus_purchase',
          user_id: userId,
        });
        return reply.code(500).send({ error: 'plus_purchase_failed' });
      }
    },
  );

  // -------------------------------------------------------------
  // GET /v1/recovery/plus/status
  // -------------------------------------------------------------
  //
  // Query param recovery_session_id. Returns { entitled: bool }.
  // NOT Plus-gated — checking whether you HAVE Plus is allowed
  // pre-purchase. Pro-gated because Plus is a Pro-tier-only feature.
  //
  // Side effect: hasRecoveryPlus() will atomically bind a NULL-session
  // pre-purchase row to this session_id on the first call. iOS surfaces
  // this endpoint as a "do I have Plus for this case?" probe; that's
  // also the moment we want the binding to happen.
  app.get(
    '/v1/recovery/plus/status',
    {
      preHandler: [requireAppUser, requireProTier],
      config: {
        rateLimit: { max: 60, timeWindow: '1 minute', ...userKeyedLimit },
      },
    },
    async (req, reply) => {
      const parsed = PlusStatusQuerySchema.safeParse(req.query ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_query', details: parsed.error.flatten() });
      }
      const userId = req.appUser!.id;
      const entitled = await hasRecoveryPlus(userId, parsed.data.recovery_session_id);
      void emitMetric('recovery_shield.route_plus_status', { entitled });
      return reply.send({ entitled });
    },
  );

  // ================================================================
  // WIRE TRACE — Plus-gated
  // ================================================================

  // -------------------------------------------------------------
  // POST /v1/recovery/trace/wire — start a wire-trace case
  // -------------------------------------------------------------
  app.post(
    '/v1/recovery/trace/wire',
    {
      preHandler: [requireAppUser, requireProTier, requireRecoveryPlus(sessionFromBody)],
      config: {
        rateLimit: { max: 10, timeWindow: '1 minute', ...userKeyedLimit },
      },
    },
    async (req, reply) => {
      const parsed = WireTraceCreateBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', details: parsed.error.flatten() });
      }
      const userId = req.appUser!.id;
      try {
        const result = await startWireTraceCase({
          user_id: userId,
          recovery_session_id: parsed.data.recovery_session_id,
          source_bank: parsed.data.source_bank,
          destination_account_hint: parsed.data.destination_account_hint,
          wire_amount_cents: BigInt(parsed.data.wire_amount_cents),
          wire_sent_at: new Date(parsed.data.wire_sent_at),
        });
        void emitMetric('recovery_shield.route_wire_trace_started', {});
        return reply.code(201).send(result);
      } catch (err) {
        if (err instanceof WireRecoveryPlusRequiredError) {
          // Should be unreachable — preHandler enforced it. Surface
          // anyway in case of mid-flow refund webhook race.
          return reply.code(402).send({ error: 'recovery_plus_required' });
        }
        captureError(err, {
          component: 'recoveryShield.wire_trace_create',
          user_id: userId,
        });
        return reply.code(500).send({ error: 'wire_trace_create_failed' });
      }
    },
  );

  // -------------------------------------------------------------
  // GET /v1/recovery/trace/wire/:case_id
  // -------------------------------------------------------------
  //
  // Plus-gated via the query-param session_id extractor — the iOS
  // client always knows the session_id from its own state, so it's
  // cheaper to pass it than to make us look it up here.
  app.get(
    '/v1/recovery/trace/wire/:case_id',
    {
      preHandler: [requireAppUser, requireProTier, requireRecoveryPlus(sessionFromQuery)],
      config: {
        rateLimit: { max: 60, timeWindow: '1 minute', ...userKeyedLimit },
      },
    },
    async (req, reply) => {
      const { case_id } = req.params as { case_id: string };
      if (!UuidSchema.safeParse(case_id).success) {
        return reply.code(400).send({ error: 'invalid_case_id' });
      }
      const userId = req.appUser!.id;
      const row = await getWireTraceCase({ case_id, user_id: userId });
      if (!row) {
        return reply.code(404).send({ error: 'not_found' });
      }
      void emitMetric('recovery_shield.route_wire_trace_read', {});
      return reply.send(wireTraceCaseToDTO(row));
    },
  );

  // -------------------------------------------------------------
  // POST /v1/recovery/trace/wire/:case_id/advance
  // -------------------------------------------------------------
  app.post(
    '/v1/recovery/trace/wire/:case_id/advance',
    {
      preHandler: [requireAppUser, requireProTier, requireRecoveryPlus(sessionFromBody)],
      config: {
        rateLimit: { max: 30, timeWindow: '1 minute', ...userKeyedLimit },
      },
    },
    async (req, reply) => {
      const { case_id } = req.params as { case_id: string };
      if (!UuidSchema.safeParse(case_id).success) {
        return reply.code(400).send({ error: 'invalid_case_id' });
      }
      const parsed = WireTraceAdvanceBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', details: parsed.error.flatten() });
      }
      const userId = req.appUser!.id;
      try {
        const result = await advanceWireTraceCase({
          case_id,
          user_id: userId,
          next_state: parsed.data.next_state,
          bank_response_text: parsed.data.bank_response_text,
        });
        void emitMetric('recovery_shield.route_wire_trace_advanced', {
          next_state: parsed.data.next_state,
        });
        return reply.send(result);
      } catch (err) {
        if (err instanceof WireNotFoundError) {
          return reply.code(404).send({ error: 'not_found' });
        }
        if (err instanceof WireInvalidStateTransitionError) {
          return reply.code(409).send({ error: 'invalid_state_transition' });
        }
        if (err instanceof WireRecoveryPlusRequiredError) {
          return reply.code(402).send({ error: 'recovery_plus_required' });
        }
        captureError(err, {
          component: 'recoveryShield.wire_trace_advance',
          user_id: userId,
        });
        return reply.code(500).send({ error: 'wire_trace_advance_failed' });
      }
    },
  );

  // -------------------------------------------------------------
  // POST /v1/recovery/trace/wire/:case_id/letter
  // -------------------------------------------------------------
  //
  // LLM-driven dispute-letter generation. Rate-limited tighter (5/min)
  // because each call burns a model token budget; iOS shouldn't be
  // generating multiple letters per minute for the same case.
  app.post(
    '/v1/recovery/trace/wire/:case_id/letter',
    {
      preHandler: [requireAppUser, requireProTier, requireRecoveryPlus(sessionFromBody)],
      config: {
        rateLimit: { max: 5, timeWindow: '1 minute', ...userKeyedLimit },
      },
    },
    async (req, reply) => {
      const { case_id } = req.params as { case_id: string };
      if (!UuidSchema.safeParse(case_id).success) {
        return reply.code(400).send({ error: 'invalid_case_id' });
      }
      const parsed = WireTraceLetterBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', details: parsed.error.flatten() });
      }
      const userId = req.appUser!.id;
      try {
        const result = await generateDisputeLetter({ case_id, user_id: userId });
        void emitMetric('recovery_shield.route_wire_letter_generated', {});
        return reply.send({ letter_text: result.letter_text });
      } catch (err) {
        if (err instanceof WireNotFoundError) {
          return reply.code(404).send({ error: 'not_found' });
        }
        if (err instanceof WireRecoveryPlusRequiredError) {
          return reply.code(402).send({ error: 'recovery_plus_required' });
        }
        captureError(err, {
          component: 'recoveryShield.wire_trace_letter',
          user_id: userId,
        });
        return reply.code(502).send({ error: 'trace_unavailable' });
      }
    },
  );

  // ================================================================
  // CRYPTO TRACE — Plus-gated
  // ================================================================

  // -------------------------------------------------------------
  // POST /v1/recovery/trace/crypto — start a crypto-trace case
  // -------------------------------------------------------------
  app.post(
    '/v1/recovery/trace/crypto',
    {
      preHandler: [requireAppUser, requireProTier, requireRecoveryPlus(sessionFromBody)],
      config: {
        rateLimit: { max: 10, timeWindow: '1 minute', ...userKeyedLimit },
      },
    },
    async (req, reply) => {
      const parsed = CryptoTraceCreateBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', details: parsed.error.flatten() });
      }
      const userId = req.appUser!.id;
      try {
        const result = await startCryptoTraceCase({
          user_id: userId,
          recovery_session_id: parsed.data.recovery_session_id,
          source_wallet: parsed.data.source_wallet,
          destination_wallet: parsed.data.destination_wallet,
          chain: parsed.data.chain,
          amount_native: parsed.data.amount_native,
          amount_usd_cents_at_send: BigInt(parsed.data.amount_usd_cents_at_send),
        });
        void emitMetric('recovery_shield.route_crypto_trace_started', {
          chain: parsed.data.chain,
        });
        return reply.code(201).send(result);
      } catch (err) {
        if (err instanceof CryptoRecoveryPlusRequiredError) {
          return reply.code(402).send({ error: 'recovery_plus_required' });
        }
        captureError(err, {
          component: 'recoveryShield.crypto_trace_create',
          user_id: userId,
        });
        return reply.code(500).send({ error: 'crypto_trace_create_failed' });
      }
    },
  );

  // -------------------------------------------------------------
  // GET /v1/recovery/trace/crypto/:case_id
  // -------------------------------------------------------------
  app.get(
    '/v1/recovery/trace/crypto/:case_id',
    {
      preHandler: [requireAppUser, requireProTier, requireRecoveryPlus(sessionFromQuery)],
      config: {
        rateLimit: { max: 60, timeWindow: '1 minute', ...userKeyedLimit },
      },
    },
    async (req, reply) => {
      const { case_id } = req.params as { case_id: string };
      if (!UuidSchema.safeParse(case_id).success) {
        return reply.code(400).send({ error: 'invalid_case_id' });
      }
      const userId = req.appUser!.id;
      const row = await getCryptoTraceCase({ case_id, user_id: userId });
      if (!row) {
        return reply.code(404).send({ error: 'not_found' });
      }
      void emitMetric('recovery_shield.route_crypto_trace_read', {});
      return reply.send(cryptoTraceCaseToDTO(row));
    },
  );

  // -------------------------------------------------------------
  // POST /v1/recovery/trace/crypto/:case_id/hops
  // -------------------------------------------------------------
  //
  // Walk forward N hops on-chain. Tight rate limit (5/min) — each
  // call hammers chain RPC + tagger services, and iOS only needs
  // one hop walk per case in the happy path.
  app.post(
    '/v1/recovery/trace/crypto/:case_id/hops',
    {
      preHandler: [requireAppUser, requireProTier, requireRecoveryPlus(sessionFromBody)],
      config: {
        rateLimit: { max: 5, timeWindow: '1 minute', ...userKeyedLimit },
      },
    },
    async (req, reply) => {
      const { case_id } = req.params as { case_id: string };
      if (!UuidSchema.safeParse(case_id).success) {
        return reply.code(400).send({ error: 'invalid_case_id' });
      }
      const parsed = CryptoTraceHopsBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', details: parsed.error.flatten() });
      }
      const userId = req.appUser!.id;
      try {
        const result = await runTraceHops({
          case_id,
          user_id: userId,
          max_hops: parsed.data.max_hops,
        });
        void emitMetric('recovery_shield.route_crypto_trace_hops', {
          exchange_tagged: result.exchange_tagged ?? 'none',
        });
        return reply.send(result);
      } catch (err) {
        if (err instanceof CryptoTraceCaseNotFoundError) {
          return reply.code(404).send({ error: 'not_found' });
        }
        if (err instanceof CryptoRecoveryPlusRequiredError) {
          return reply.code(402).send({ error: 'recovery_plus_required' });
        }
        captureError(err, {
          component: 'recoveryShield.crypto_trace_hops',
          user_id: userId,
        });
        return reply.code(502).send({ error: 'trace_unavailable' });
      }
    },
  );

  // -------------------------------------------------------------
  // POST /v1/recovery/trace/crypto/:case_id/petition
  // -------------------------------------------------------------
  app.post(
    '/v1/recovery/trace/crypto/:case_id/petition',
    {
      preHandler: [requireAppUser, requireProTier, requireRecoveryPlus(sessionFromBody)],
      config: {
        rateLimit: { max: 5, timeWindow: '1 minute', ...userKeyedLimit },
      },
    },
    async (req, reply) => {
      const { case_id } = req.params as { case_id: string };
      if (!UuidSchema.safeParse(case_id).success) {
        return reply.code(400).send({ error: 'invalid_case_id' });
      }
      const parsed = CryptoTracePetitionBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', details: parsed.error.flatten() });
      }
      const userId = req.appUser!.id;
      try {
        const result = await generateExchangePetition({ case_id, user_id: userId });
        void emitMetric('recovery_shield.route_crypto_petition_generated', {});
        return reply.send({ petition_text: result.petition_text });
      } catch (err) {
        if (err instanceof CryptoTraceCaseNotFoundError) {
          return reply.code(404).send({ error: 'not_found' });
        }
        if (err instanceof CryptoInvalidStateError) {
          return reply.code(409).send({ error: 'invalid_state_transition', message: err.message });
        }
        if (err instanceof CryptoRecoveryPlusRequiredError) {
          return reply.code(402).send({ error: 'recovery_plus_required' });
        }
        captureError(err, {
          component: 'recoveryShield.crypto_trace_petition',
          user_id: userId,
        });
        return reply.code(502).send({ error: 'trace_unavailable' });
      }
    },
  );

  // -------------------------------------------------------------
  // POST /v1/recovery/trace/crypto/:case_id/advance
  // -------------------------------------------------------------
  app.post(
    '/v1/recovery/trace/crypto/:case_id/advance',
    {
      preHandler: [requireAppUser, requireProTier, requireRecoveryPlus(sessionFromBody)],
      config: {
        rateLimit: { max: 30, timeWindow: '1 minute', ...userKeyedLimit },
      },
    },
    async (req, reply) => {
      const { case_id } = req.params as { case_id: string };
      if (!UuidSchema.safeParse(case_id).success) {
        return reply.code(400).send({ error: 'invalid_case_id' });
      }
      const parsed = CryptoTraceAdvanceBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', details: parsed.error.flatten() });
      }
      const userId = req.appUser!.id;
      try {
        const result = await advanceCryptoTraceCase({
          case_id,
          user_id: userId,
          next_state: parsed.data.next_state,
        });
        void emitMetric('recovery_shield.route_crypto_trace_advanced', {
          next_state: parsed.data.next_state,
        });
        return reply.send(result);
      } catch (err) {
        if (err instanceof CryptoTraceCaseNotFoundError) {
          return reply.code(404).send({ error: 'not_found' });
        }
        if (err instanceof CryptoInvalidStateError) {
          return reply.code(409).send({ error: 'invalid_state_transition', message: err.message });
        }
        if (err instanceof CryptoRecoveryPlusRequiredError) {
          return reply.code(402).send({ error: 'recovery_plus_required' });
        }
        captureError(err, {
          component: 'recoveryShield.crypto_trace_advance',
          user_id: userId,
        });
        return reply.code(500).send({ error: 'crypto_trace_advance_failed' });
      }
    },
  );

  // ================================================================
  // LEGAL DOCUMENTS
  // ================================================================

  // -------------------------------------------------------------
  // POST /v1/recovery/documents/generate — Plus-gated
  // -------------------------------------------------------------
  //
  // Tightest rate limit (5/min) — each call fans out to N LLM
  // generators in parallel.
  app.post(
    '/v1/recovery/documents/generate',
    {
      preHandler: [requireAppUser, requireProTier, requireRecoveryPlus(sessionFromBody)],
      config: {
        rateLimit: { max: 5, timeWindow: '1 minute', ...userKeyedLimit },
      },
    },
    async (req, reply) => {
      const parsed = DocumentsGenerateBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', details: parsed.error.flatten() });
      }
      if (!parsed.data.user_acknowledged_disclaimer) {
        // Hard pre-check before we burn LLM budget. Service layer
        // re-validates, but surfacing this at the API boundary gives
        // iOS a tighter error path.
        return reply.code(400).send({
          error: 'disclaimer_not_acknowledged',
          message:
            'user_acknowledged_disclaimer must be true. Show the disclaimer modal first.',
        });
      }
      const userId = req.appUser!.id;
      try {
        const result = await generateLegalPacket({
          user_id: userId,
          recovery_session_id: parsed.data.recovery_session_id,
          doc_kinds: parsed.data.doc_kinds,
          state_jurisdiction: parsed.data.state_jurisdiction,
          user_acknowledged_disclaimer: parsed.data.user_acknowledged_disclaimer,
          case_facts: {
            scam_type: parsed.data.case_facts.scam_type,
            amount_lost_cents: BigInt(parsed.data.case_facts.amount_lost_cents),
            scam_actor_descriptor: parsed.data.case_facts.scam_actor_descriptor,
            scam_actor_contact: parsed.data.case_facts.scam_actor_contact,
            incident_date: new Date(parsed.data.case_facts.incident_date),
            description_summary: parsed.data.case_facts.description_summary,
          },
          opts: { llmFn: legalPacketLlmFn },
        });
        void emitMetric('recovery_shield.route_documents_generated', {
          doc_count: result.generated.length,
          skipped_count: result.skipped.length,
        });
        return reply.code(201).send(result);
      } catch (err) {
        if (err instanceof DisclaimerNotAcknowledgedError) {
          return reply.code(400).send({ error: 'disclaimer_not_acknowledged' });
        }
        if (err instanceof DocRecoveryPlusRequiredError) {
          return reply.code(402).send({ error: 'recovery_plus_required' });
        }
        captureError(err, {
          component: 'recoveryShield.documents_generate',
          user_id: userId,
        });
        return reply.code(502).send({ error: 'trace_unavailable' });
      }
    },
  );

  // -------------------------------------------------------------
  // GET /v1/recovery/documents — Pro-only (not Plus)
  // -------------------------------------------------------------
  //
  // Listing your own docs is Pro-only by design: a user whose Plus
  // entitlement was refunded should still be able to retrieve docs
  // they generated before the refund. The route service layer's
  // SELECT is user-scoped; no Plus check happens here.
  app.get(
    '/v1/recovery/documents',
    {
      preHandler: [requireAppUser, requireProTier],
      config: {
        rateLimit: { max: 60, timeWindow: '1 minute', ...userKeyedLimit },
      },
    },
    async (req, reply) => {
      const parsed = DocumentsListQuerySchema.safeParse(req.query ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_query', details: parsed.error.flatten() });
      }
      const userId = req.appUser!.id;
      const rows = await listLegalDocuments({
        user_id: userId,
        recovery_session_id: parsed.data.recovery_session_id,
      });
      void emitMetric('recovery_shield.route_documents_listed', {});
      return reply.send({ documents: rows.map(legalDocumentToDTO) });
    },
  );

  // -------------------------------------------------------------
  // GET /v1/recovery/documents/:document_id — Pro-only
  // -------------------------------------------------------------
  app.get(
    '/v1/recovery/documents/:document_id',
    {
      preHandler: [requireAppUser, requireProTier],
      config: {
        rateLimit: { max: 60, timeWindow: '1 minute', ...userKeyedLimit },
      },
    },
    async (req, reply) => {
      const { document_id } = req.params as { document_id: string };
      if (!UuidSchema.safeParse(document_id).success) {
        return reply.code(400).send({ error: 'invalid_document_id' });
      }
      const userId = req.appUser!.id;
      const row = await getLegalDocument({ document_id, user_id: userId });
      if (!row) {
        return reply.code(404).send({ error: 'not_found' });
      }
      void emitMetric('recovery_shield.route_document_read', {});
      return reply.send(legalDocumentToDTO(row));
    },
  );

  // ================================================================
  // SPECIALIST MARKETPLACE
  // ================================================================

  // -------------------------------------------------------------
  // GET /v1/recovery/specialists — Pro-only (browse is open to Pro)
  // -------------------------------------------------------------
  //
  // Pre-purchase browse is intentional — surfacing the marketplace
  // before the user buys Plus is a conversion lever. Plus is gated
  // at the `refer` step.
  app.get(
    '/v1/recovery/specialists',
    {
      preHandler: [requireAppUser, requireProTier],
      config: {
        rateLimit: { max: 60, timeWindow: '1 minute', ...userKeyedLimit },
      },
    },
    async (req, reply) => {
      const parsed = SpecialistsListQuerySchema.safeParse(req.query ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_query', details: parsed.error.flatten() });
      }
      const rows = await listSpecialistsFor(
        {
          category: parsed.data.category,
          jurisdiction: parsed.data.jurisdiction,
          capabilities: parsed.data.capabilities,
        },
        { limit: parsed.data.limit },
      );
      void emitMetric('recovery_shield.route_specialists_listed', {});
      return reply.send({
        specialists: rows.map((s) => ({
          id: s.id,
          display_name: s.display_name,
          category: s.category,
          jurisdictions: s.jurisdictions,
          capabilities: s.capabilities,
          // commission_pct is admin-facing financial info; the
          // marketplace surface returns it so iOS can render the fee
          // disclosure card before referral (a transparency requirement
          // for the fee disclosure modal).
          commission_pct: s.commission_pct,
          contact_email: s.contact_email,
          contact_phone: s.contact_phone,
          bar_number: s.bar_number,
        })),
      });
    },
  );

  // -------------------------------------------------------------
  // GET /v1/recovery/specialists/:specialist_id — Pro-only
  // -------------------------------------------------------------
  app.get(
    '/v1/recovery/specialists/:specialist_id',
    {
      preHandler: [requireAppUser, requireProTier],
      config: {
        rateLimit: { max: 60, timeWindow: '1 minute', ...userKeyedLimit },
      },
    },
    async (req, reply) => {
      const { specialist_id } = req.params as { specialist_id: string };
      if (!UuidSchema.safeParse(specialist_id).success) {
        return reply.code(400).send({ error: 'invalid_specialist_id' });
      }
      const row = await getSpecialist(specialist_id);
      if (!row) {
        return reply.code(404).send({ error: 'not_found' });
      }
      void emitMetric('recovery_shield.route_specialist_read', {});
      // `notes` is intentionally omitted — migration 066 documents the
      // column as admin-only (operational scoring + vetting commentary).
      // The list route omits it; the single-specialist GET must match
      // (adversarial-review R-M1).
      return reply.send({
        id: row.id,
        display_name: row.display_name,
        category: row.category,
        jurisdictions: row.jurisdictions,
        capabilities: row.capabilities,
        commission_pct: row.commission_pct,
        contact_email: row.contact_email,
        contact_phone: row.contact_phone,
        bar_number: row.bar_number,
      });
    },
  );

  // -------------------------------------------------------------
  // POST /v1/recovery/specialists/refer — Plus-gated
  // -------------------------------------------------------------
  //
  // Creates the referral row. The actual specialist-email kick is
  // an operational concern (queued via the admin path / specialist
  // webhook); we emit a metric here so the operator dashboard can
  // see the referral fire-and-forget completing at the route boundary.
  app.post(
    '/v1/recovery/specialists/refer',
    {
      preHandler: [requireAppUser, requireProTier, requireRecoveryPlus(sessionFromBody)],
      config: {
        rateLimit: { max: 10, timeWindow: '1 minute', ...userKeyedLimit },
      },
    },
    async (req, reply) => {
      const parsed = SpecialistReferBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', details: parsed.error.flatten() });
      }
      const userId = req.appUser!.id;
      try {
        const result = await createReferral({
          user_id: userId,
          specialist_id: parsed.data.specialist_id,
          recovery_session_id: parsed.data.recovery_session_id,
        });
        void emitMetric('recovery_shield.route_specialist_referred', {});
        return reply.code(201).send(result);
      } catch (err) {
        if (err instanceof SpecialistNotAvailableError) {
          return reply.code(404).send({ error: 'specialist_not_available' });
        }
        if (err instanceof RecoverySessionNotFoundError) {
          return reply.code(404).send({ error: 'recovery_session_not_found' });
        }
        if (err instanceof MarketRecoveryPlusRequiredError) {
          return reply.code(402).send({ error: 'recovery_plus_required' });
        }
        captureError(err, {
          component: 'recoveryShield.specialist_refer',
          user_id: userId,
        });
        return reply.code(500).send({ error: 'specialist_refer_failed' });
      }
    },
  );

  // -------------------------------------------------------------
  // GET /v1/recovery/referrals — Pro-only
  // -------------------------------------------------------------
  //
  // Listing past referrals doesn't require active Plus — a user
  // whose entitlement lapsed still owns the historical fact that
  // they made referral X. user_id scoping at the service layer
  // keeps cross-user reads at zero rows.
  app.get(
    '/v1/recovery/referrals',
    {
      preHandler: [requireAppUser, requireProTier],
      config: {
        rateLimit: { max: 60, timeWindow: '1 minute', ...userKeyedLimit },
      },
    },
    async (req, reply) => {
      const parsed = ReferralsListQuerySchema.safeParse(req.query ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_query', details: parsed.error.flatten() });
      }
      const userId = req.appUser!.id;
      const rows = await listReferralsForUser(userId, {
        recovery_session_id: parsed.data.recovery_session_id,
      });
      void emitMetric('recovery_shield.route_referrals_listed', {});
      return reply.send({
        referrals: rows.map((r) => ({
          id: r.id,
          specialist_id: r.specialist_id,
          recovery_session_id: r.recovery_session_id,
          referred_at: r.referred_at.toISOString(),
          specialist_acknowledged_at: r.specialist_acknowledged_at?.toISOString() ?? null,
          engagement_status: r.engagement_status,
          // Fee fields exposed read-only (the user can see what
          // they're being charged); admin / specialist surfaces write.
          fee_owed_cents: r.fee_owed_cents,
          fee_paid_at: r.fee_paid_at?.toISOString() ?? null,
          // outcome_notes is admin-only commentary; deliberately NOT
          // surfaced in the user-facing list per specialistMarketplace.ts
          // comments.
        })),
      });
    },
  );
}
