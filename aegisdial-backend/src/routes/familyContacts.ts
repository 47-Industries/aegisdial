import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import bcrypt from 'bcrypt';
import { query } from '../lib/db.js';
import { requireAppUser, requireProTier } from '../lib/auth.js';
import { normalizeE164 } from '../lib/phone.js';
import { emitGuardianAlert } from '../services/guardianAlerts.js';
import { encryptString, readMaybeEncrypted } from '../lib/crypto.js';

// Family contacts registry. The "deepfake defense" layer:
//   - register trusted numbers ahead of time
//   - set a shared safe word with each contact
//   - optionally set a challenge/answer pair
//
// When an emergency-relative scam starts, the user can open the contact
// by phone-match and either (a) call back on the saved number, or
// (b) ask for the safe word and verify it here.

const BCRYPT_ROUNDS = 10;

// .nullable() lets the client send `null` to clear the field on update.
// No .default() anywhere — .partial() on an UPDATE schema would otherwise
// apply the default on PATCHes that didn't mention the field, silently
// demoting (e.g.) is_guardian to false.
const CREATE_SCHEMA = z.object({
  display_name: z.string().min(1).max(80),
  phone: z.string().min(4).max(20),
  relationship: z
    .enum(['parent','child','spouse','sibling','grandparent','grandchild','friend','bank','doctor','attorney','other'])
    .nullable()
    .optional(),
  is_guardian: z.boolean().optional(),
  safe_word: z.string().min(2).max(80).nullable().optional(),
  challenge_prompt: z.string().max(200).nullable().optional(),
  challenge_answer: z.string().min(1).max(200).nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
});

const UPDATE_SCHEMA = CREATE_SCHEMA.partial();

const VERIFY_SCHEMA = z.object({
  value: z.string().min(1).max(200),
  call_session_id: z.string().uuid().optional(),
  kind: z.enum(['safe_word','challenge']).optional().default('safe_word'),
});

export async function familyContactsRoutes(app: FastifyInstance): Promise<void> {
  // List contacts.
  app.get(
    '/v1/family-contacts',
    { preHandler: [requireAppUser, requireProTier] },
    async (req, reply) => {
      const user = req.appUser!;
      const rows = await listContacts(user.id);
      return reply.send({ contacts: rows });
    },
  );

  // Lookup by phone — used by Live Shield to match a peer number to a
  // registered contact and surface the "call them back" CTA.
  app.get(
    '/v1/family-contacts/by-phone/:phone',
    { preHandler: [requireAppUser, requireProTier] },
    async (req, reply) => {
      const user = req.appUser!;
      const { phone } = req.params as { phone: string };
      const e164 = normalizeE164(phone);
      if (!e164) return reply.code(400).send({ error: 'invalid_phone' });
      const rows = await query<ContactRow>(
        `SELECT id, display_name, display_name_ct, phone_e164, relationship, is_guardian,
                safe_word_hash IS NOT NULL AS has_safe_word,
                challenge_prompt, challenge_answer_hash IS NOT NULL AS has_challenge,
                notes, notes_ct, created_at, updated_at
           FROM family_contacts
          WHERE user_id = $1 AND phone_e164 = $2`,
        [user.id, e164],
      );
      if (rows.rows.length === 0) return reply.send({ contact: null });
      return reply.send({ contact: publicShape(rows.rows[0]!) });
    },
  );

  // Create.
  app.post(
    '/v1/family-contacts',
    { preHandler: [requireAppUser, requireProTier] },
    async (req, reply) => {
      const user = req.appUser!;
      const parsed = CREATE_SCHEMA.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
      const e164 = normalizeE164(parsed.data.phone);
      if (!e164) return reply.code(400).send({ error: 'invalid_phone' });

      const safeWordHash = parsed.data.safe_word
        ? await bcrypt.hash(normalizeWord(parsed.data.safe_word), BCRYPT_ROUNDS)
        : null;
      const challengeAnswerHash = parsed.data.challenge_answer
        ? await bcrypt.hash(normalizeWord(parsed.data.challenge_answer), BCRYPT_ROUNDS)
        : null;

      try {
        // Dual-write encryption:
        //   - display_name: kept in plaintext column because liveShield.ts
        //     and the by-phone GET handler below still read it plaintext.
        //     We ALSO write the ciphertext copy so a future migration can
        //     flip reads + drop the plaintext column in one pass without
        //     re-encrypting every row.
        //   - notes: fully encrypted — plaintext column stored as NULL.
        //     Nothing outside this route reads notes plaintext, so we
        //     can neutralize the DB-snapshot leak today.
        const displayNameCt = encryptString(parsed.data.display_name);
        const notesCt = parsed.data.notes ? encryptString(parsed.data.notes) : null;
        const res = await query<{ id: string }>(
          `INSERT INTO family_contacts
             (user_id, display_name, display_name_ct, phone_e164, relationship, is_guardian,
              safe_word_hash, challenge_prompt, challenge_answer_hash, notes, notes_ct)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           RETURNING id`,
          [
            user.id,
            parsed.data.display_name,
            displayNameCt,
            e164,
            parsed.data.relationship ?? null,
            parsed.data.is_guardian ?? false, // create-only default
            safeWordHash,
            parsed.data.challenge_prompt ?? null,
            challengeAnswerHash,
            null, // notes plaintext — we hold only the ciphertext
            notesCt,
          ],
        );
        const row = await getContact(user.id, res.rows[0]!.id);
        return reply.send({ contact: publicShape(row!) });
      } catch (err) {
        // Postgres SQLSTATE 23505 = unique_violation. Matching on the code
        // is rock-solid across pg versions / locales, unlike the old
        // /duplicate key/i regex which broke on translated server messages
        // and swallowed unrelated errors that happened to contain those
        // words. Same pattern as routes/family.ts:131.
        if ((err as { code?: string }).code === '23505') {
          return reply.code(409).send({ error: 'duplicate_phone' });
        }
        throw err;
      }
    },
  );

  // Update (including rotating the safe word).
  app.patch(
    '/v1/family-contacts/:id',
    { preHandler: [requireAppUser, requireProTier] },
    async (req, reply) => {
      const user = req.appUser!;
      const { id } = req.params as { id: string };
      const parsed = UPDATE_SCHEMA.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

      const patch = parsed.data;
      const fields: string[] = [];
      const values: unknown[] = [];
      const add = (col: string, val: unknown) => {
        values.push(val);
        fields.push(`${col} = $${values.length}`);
      };

      if (patch.display_name !== undefined) {
        // Dual-write: plaintext for liveShield.ts (still reads it) +
        // ciphertext for the eventual drop-plaintext cutover.
        add('display_name', patch.display_name);
        add('display_name_ct', encryptString(patch.display_name));
      }
      if (patch.phone !== undefined) {
        const e164 = normalizeE164(patch.phone);
        if (!e164) return reply.code(400).send({ error: 'invalid_phone' });
        add('phone_e164', e164);
      }
      if (patch.relationship !== undefined) add('relationship', patch.relationship);
      if (patch.is_guardian !== undefined) add('is_guardian', patch.is_guardian);
      // null → clear the hash; empty-string is treated the same.
      if (patch.safe_word !== undefined) {
        const pw = patch.safe_word ?? '';
        const h = pw ? await bcrypt.hash(normalizeWord(pw), BCRYPT_ROUNDS) : null;
        add('safe_word_hash', h);
      }
      if (patch.challenge_prompt !== undefined) add('challenge_prompt', patch.challenge_prompt);
      if (patch.challenge_answer !== undefined) {
        const ans = patch.challenge_answer ?? '';
        const h = ans ? await bcrypt.hash(normalizeWord(ans), BCRYPT_ROUNDS) : null;
        add('challenge_answer_hash', h);
      }
      if (patch.notes !== undefined) {
        // Notes: encrypt-only. plaintext column always nulled on update
        // so a future snapshot leak never contains notes, including for
        // rows being edited right now.
        add('notes', null);
        add('notes_ct', patch.notes ? encryptString(patch.notes) : null);
      }

      if (fields.length === 0) {
        const row = await getContact(user.id, id);
        if (!row) return reply.code(404).send({ error: 'not_found' });
        return reply.send({ contact: publicShape(row) });
      }

      values.push(id, user.id);
      const sql = `UPDATE family_contacts SET ${fields.join(', ')}, updated_at = NOW()
                     WHERE id = $${values.length - 1} AND user_id = $${values.length}
                   RETURNING id`;
      const res = await query<{ id: string }>(sql, values);
      if (res.rows.length === 0) return reply.code(404).send({ error: 'not_found' });
      const row = await getContact(user.id, id);
      return reply.send({ contact: publicShape(row!) });
    },
  );

  // Delete.
  app.delete(
    '/v1/family-contacts/:id',
    { preHandler: [requireAppUser, requireProTier] },
    async (req, reply) => {
      const user = req.appUser!;
      const { id } = req.params as { id: string };
      const res = await query(
        `DELETE FROM family_contacts WHERE id = $1 AND user_id = $2`,
        [id, user.id],
      );
      if (res.rowCount === 0) return reply.code(404).send({ error: 'not_found' });
      return reply.send({ deleted: true });
    },
  );

  // Verify a safe word / challenge answer against a contact. Kind is
  // recorded in family_verifications so we have an audit trail.
  //
  // Rate-limited: 10 attempts per minute per user to slow any brute
  // force on a leaked device token. bcrypt rounds=10 already makes this
  // expensive but defense-in-depth matters here.
  app.post(
    '/v1/family-contacts/:id/verify',
    {
      preHandler: [requireAppUser, requireProTier],
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '1 minute',
          keyGenerator: (req) => req.appUser?.id ?? req.ip,
        },
      },
    },
    async (req, reply) => {
      const user = req.appUser!;
      const { id } = req.params as { id: string };
      const parsed = VERIFY_SCHEMA.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

      const row = await getContact(user.id, id);
      if (!row) return reply.code(404).send({ error: 'not_found' });

      const stored =
        parsed.data.kind === 'safe_word' ? row.safe_word_hash : row.challenge_answer_hash;
      if (!stored) {
        return reply.code(400).send({ error: 'no_value_configured' });
      }

      const match = await bcrypt.compare(normalizeWord(parsed.data.value), stored);

      await query(
        `INSERT INTO family_verifications
            (user_id, family_contact_id, call_session_id, verification_type, success)
          VALUES ($1, $2, $3, $4, $5)`,
        [user.id, row.id, parsed.data.call_session_id ?? null, parsed.data.kind, match],
      );

      // If the safe word failed during an active call, tell guardians —
      // the caller is almost certainly not who they claim to be.
      if (!match && parsed.data.call_session_id) {
        const displayName = resolveDisplayName(row);
        void emitGuardianAlert({
          subjectUserId: user.id,
          kind: 'safe_word_failed',
          severity: 'critical',
          title: `Safe word FAILED for ${displayName}`,
          body:
            `${displayName} (${row.phone_e164}) did not know the shared safe word. ` +
            `This is a strong signal of a voice-cloning or impersonation scam in progress.`,
          payload: {
            contact_id: row.id,
            display_name: displayName,
            phone: row.phone_e164,
            call_session_id: parsed.data.call_session_id,
          },
        });
      }

      return reply.send({ match });
    },
  );
}

// --- helpers ---

interface ContactRow {
  id: string;
  display_name: string | null;
  display_name_ct: string | null;
  phone_e164: string;
  relationship: string | null;
  is_guardian: boolean;
  has_safe_word: boolean;
  challenge_prompt: string | null;
  has_challenge: boolean;
  notes: string | null;
  notes_ct: string | null;
  created_at: Date;
  updated_at: Date;
  safe_word_hash?: string | null;
  challenge_answer_hash?: string | null;
}

async function listContacts(userId: string): Promise<ReturnType<typeof publicShape>[]> {
  const rows = await query<ContactRow>(
    `SELECT id, display_name, display_name_ct, phone_e164, relationship, is_guardian,
            safe_word_hash IS NOT NULL AS has_safe_word,
            challenge_prompt, challenge_answer_hash IS NOT NULL AS has_challenge,
            notes, notes_ct, created_at, updated_at
       FROM family_contacts
      WHERE user_id = $1
      ORDER BY is_guardian DESC, display_name ASC`,
    [userId],
  );
  return rows.rows.map(publicShape);
}

async function getContact(userId: string, id: string): Promise<ContactRow | null> {
  const rows = await query<ContactRow>(
    `SELECT id, display_name, display_name_ct, phone_e164, relationship, is_guardian,
            safe_word_hash, safe_word_hash IS NOT NULL AS has_safe_word,
            challenge_prompt, challenge_answer_hash, challenge_answer_hash IS NOT NULL AS has_challenge,
            notes, notes_ct, created_at, updated_at
       FROM family_contacts
      WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return rows.rows[0] ?? null;
}

function publicShape(row: ContactRow) {
  return {
    id: row.id,
    display_name: resolveDisplayName(row),
    phone: row.phone_e164,
    relationship: row.relationship,
    is_guardian: row.is_guardian,
    has_safe_word: row.has_safe_word,
    challenge_prompt: row.challenge_prompt,
    has_challenge: row.has_challenge,
    notes: resolveNotes(row),
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

// Prefer the ciphertext column (authoritative post-migration 031); fall
// back to plaintext for legacy rows written before dual-write shipped.
// Returns '' when nothing is set so the public response stays typed as
// string rather than nullable (display_name is required at create time).
function resolveDisplayName(row: ContactRow): string {
  const fromCt = row.display_name_ct ? readMaybeEncrypted(row.display_name_ct) : null;
  return fromCt ?? row.display_name ?? '';
}

function resolveNotes(row: ContactRow): string | null {
  const fromCt = row.notes_ct ? readMaybeEncrypted(row.notes_ct) : null;
  return fromCt ?? row.notes ?? null;
}

/**
 * Lowercased + trimmed. Safe words are shared between people; users
 * will type them with different capitalization and spacing. Hashing
 * the normalized form means "MAGNOLIA" and "magnolia" match.
 */
function normalizeWord(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}
