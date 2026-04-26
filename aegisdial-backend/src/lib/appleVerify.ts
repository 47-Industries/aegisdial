import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SignedDataVerifier,
  Environment,
} from '@apple/app-store-server-library';
import { config } from '../config.js';

// Apple StoreKit 2 JWS verification.
//
// On every purchase the client hands us a JWS-encoded transaction payload
// (Apple's term: "signedTransactionInfo"). We verify:
//   1. The JWS signature chains up to an Apple root certificate.
//   2. The bundleId in the payload matches our app.
//   3. The environment matches our config (sandbox/production).
// The library throws on any failure — we surface those as 400s.
//
// The verifier is instantiated lazily and cached; Apple roots are read from
// disk once and never change.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CERTS_DIR = path.resolve(__dirname, '../../certs');

let cachedVerifier: SignedDataVerifier | null = null;

async function loadVerifier(): Promise<SignedDataVerifier> {
  if (cachedVerifier) return cachedVerifier;
  const names = [
    'AppleIncRootCertificate.cer',
    'AppleRootCA-G2.cer',
    'AppleRootCA-G3.cer',
  ];
  const buffers = await Promise.all(
    names.map((n) => readFile(path.join(CERTS_DIR, n))),
  );
  const env =
    config.APPLE_STOREKIT_ENV === 'production'
      ? Environment.PRODUCTION
      : Environment.SANDBOX;
  cachedVerifier = new SignedDataVerifier(
    buffers,
    true, // enableOnlineChecks — OCSP
    env,
    config.APPLE_BUNDLE_ID,
    config.APPLE_APP_APPLE_ID,
  );
  return cachedVerifier;
}

export interface DecodedTransaction {
  transactionId: string;
  originalTransactionId: string;
  productId: string;
  bundleId: string;
  purchaseDateMs: number;
  expiresDateMs: number | null;
  type: string;
  environment: string;
  /**
   * Apple's appAccountToken is a UUID the client sets at purchase time so
   * we can bind a transaction to a specific backend user. Optional on
   * older clients that predate the iOS change — fall back to user-id
   * ownership checks at the DB layer when absent.
   */
  appAccountToken: string | null;
  raw: Record<string, unknown>;
}

export async function verifyAppleTransactionJws(jws: string): Promise<DecodedTransaction> {
  const verifier = await loadVerifier();
  // verifyAndDecodeTransaction returns JWSTransactionDecodedPayload. The
  // concrete class doesn't expose an index signature, so we reach through
  // `unknown` to read known-optional fields by key.
  const decoded = (await verifier.verifyAndDecodeTransaction(jws)) as unknown as Record<string, unknown>;

  const transactionId = String(decoded.transactionId ?? '');
  const originalTransactionId = String(decoded.originalTransactionId ?? transactionId);
  const productId = String(decoded.productId ?? '');
  const bundleId = String(decoded.bundleId ?? '');
  const purchaseDateMs = Number(decoded.purchaseDate ?? Date.now());
  const expiresRaw = decoded.expiresDate;
  const expiresDateMs = typeof expiresRaw === 'number' ? expiresRaw : null;
  const type = String(decoded.type ?? 'Auto-Renewable Subscription');
  const environment = String(decoded.environment ?? config.APPLE_STOREKIT_ENV);
  const appAccountTokenRaw = decoded.appAccountToken;
  const appAccountToken =
    typeof appAccountTokenRaw === 'string' && appAccountTokenRaw.length > 0
      ? appAccountTokenRaw
      : null;

  if (bundleId !== config.APPLE_BUNDLE_ID) {
    throw new Error(`bundleId mismatch: expected ${config.APPLE_BUNDLE_ID}, got ${bundleId}`);
  }
  if (!transactionId || !productId) {
    throw new Error('transaction missing required fields');
  }
  return {
    transactionId,
    originalTransactionId,
    productId,
    bundleId,
    purchaseDateMs,
    expiresDateMs,
    type,
    environment,
    appAccountToken,
    raw: decoded,
  };
}

// Shape of a verified S2S notification v2 payload as our routes consume
// it. We mirror the subset of Apple's ResponseBodyV2DecodedPayload that
// the notification handler needs to route state changes into the DB,
// plus optional pre-decoded inner JWS payloads for ergonomic access.
//
// The raw library return type is hidden behind our own interface so the
// handler code doesn't have to wrestle with the SDK's optional-all-the-
// way-down shape everywhere it touches a notification.
export interface DecodedNotification {
  notificationType: string;
  subtype: string | null;
  notificationUUID: string | null;
  signedDate: number | null;
  /** Inner transaction JWS before verification. Pass to verifyAppleNotificationTransaction. */
  signedTransactionInfo: string | null;
  /** Inner renewal-info JWS before verification. Pass to verifyAppleNotificationRenewalInfo. */
  signedRenewalInfo: string | null;
  /** Decoded inner transaction, if present + verified. */
  transaction: DecodedNotificationTransaction | null;
  /** Decoded inner renewal info, if present + verified. */
  renewalInfo: DecodedNotificationRenewalInfo | null;
  raw: Record<string, unknown>;
}

export interface DecodedNotificationTransaction {
  transactionId: string | null;
  originalTransactionId: string | null;
  productId: string | null;
  bundleId: string | null;
  purchaseDateMs: number | null;
  expiresDateMs: number | null;
  revocationDateMs: number | null;
  environment: string | null;
  appAccountToken: string | null;
  raw: Record<string, unknown>;
}

export interface DecodedNotificationRenewalInfo {
  originalTransactionId: string | null;
  productId: string | null;
  autoRenewStatus: number | null;
  autoRenewProductId: string | null;
  renewalDateMs: number | null;
  gracePeriodExpiresDateMs: number | null;
  expirationIntent: number | null;
  environment: string | null;
  raw: Record<string, unknown>;
}

// Verify a server-to-server notification (v2). Apple sends these when
// a subscription renews, cancels, refunds, etc. Payload is also JWS.
// If inner JWS fields (signedTransactionInfo / signedRenewalInfo) are
// present we decode + verify those too so callers don't have to replay
// the verifier plumbing for every notification type.
export async function verifyAppleNotificationJws(signedPayload: string): Promise<DecodedNotification> {
  const verifier = await loadVerifier();
  const decoded = (await verifier.verifyAndDecodeNotification(signedPayload)) as unknown as Record<string, unknown>;
  const data = (decoded.data ?? {}) as Record<string, unknown>;

  const signedTxRaw = typeof data.signedTransactionInfo === 'string' ? data.signedTransactionInfo : null;
  const signedRenewalRaw = typeof data.signedRenewalInfo === 'string' ? data.signedRenewalInfo : null;

  let transaction: DecodedNotificationTransaction | null = null;
  if (signedTxRaw) {
    try {
      const tx = (await verifier.verifyAndDecodeTransaction(signedTxRaw)) as unknown as Record<string, unknown>;
      transaction = {
        transactionId: optString(tx.transactionId),
        originalTransactionId: optString(tx.originalTransactionId),
        productId: optString(tx.productId),
        bundleId: optString(tx.bundleId),
        purchaseDateMs: optNumber(tx.purchaseDate),
        expiresDateMs: optNumber(tx.expiresDate),
        revocationDateMs: optNumber(tx.revocationDate),
        environment: optString(tx.environment),
        appAccountToken: optString(tx.appAccountToken),
        raw: tx,
      };
    } catch (err) {
      // A bad inner JWS inside an outer-verified notification is
      // suspicious but not necessarily fatal — surface as null and let
      // the route either fall back to the renewalInfo path or log+drop.
      throw new Error(`signedTransactionInfo verify failed: ${(err as Error).message}`);
    }
  }

  let renewalInfo: DecodedNotificationRenewalInfo | null = null;
  if (signedRenewalRaw) {
    try {
      const ri = (await verifier.verifyAndDecodeRenewalInfo(signedRenewalRaw)) as unknown as Record<string, unknown>;
      renewalInfo = {
        originalTransactionId: optString(ri.originalTransactionId),
        productId: optString(ri.productId),
        autoRenewStatus: optNumber(ri.autoRenewStatus),
        autoRenewProductId: optString(ri.autoRenewProductId),
        renewalDateMs: optNumber(ri.renewalDate),
        gracePeriodExpiresDateMs: optNumber(ri.gracePeriodExpiresDate),
        expirationIntent: optNumber(ri.expirationIntent),
        environment: optString(ri.environment),
        raw: ri,
      };
    } catch (err) {
      throw new Error(`signedRenewalInfo verify failed: ${(err as Error).message}`);
    }
  }

  return {
    notificationType: String(decoded.notificationType ?? ''),
    subtype: optString(decoded.subtype),
    notificationUUID: optString(decoded.notificationUUID),
    signedDate: optNumber(decoded.signedDate),
    signedTransactionInfo: signedTxRaw,
    signedRenewalInfo: signedRenewalRaw,
    transaction,
    renewalInfo,
    raw: decoded,
  };
}

function optString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function optNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
