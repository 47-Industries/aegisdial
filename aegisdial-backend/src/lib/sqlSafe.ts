// SQL safety validator for /internal/ask.
//
// Defense in depth — the natural-language-to-SQL service is told to
// generate SELECT-only queries against a small allowlist, but we never
// trust that. Every query Claude returns is validated here before it
// touches the database, and then run inside a READ ONLY transaction
// with an aggressive statement_timeout.
//
// What we block, in order:
//   1. Anything that isn't a SELECT or WITH-prefixed SELECT (CTE)
//   2. Any forbidden statement keyword (INSERT, UPDATE, DELETE, DDL,
//      transaction control, COPY, SET, EXECUTE, etc.)
//   3. Any reference to PII columns (email, phone, names, encrypted
//      payloads, scam_e164 — even though that's the scammer's number,
//      we don't want it in dashboards either)
//   4. Any table reference outside the allowlist
//   5. Multiple statements (semicolon outside a string literal)
//
// The validation is regex-based, which is not a real SQL parser. The
// READ ONLY transaction wrapper is the actual hard guarantee — even
// if a clever escape gets past these regexes, Postgres will still
// refuse to write.

export const ALLOWED_TABLES = new Set([
  'analytics_events',
  'subscriptions',
  'recovery_sessions',
  'recovery_steps',
  'call_sessions',
  'breach_alerts',
  'guardian_alerts',
  'plan_prices',
  'mv_kpi_mrr',
  'mv_kpi_active_subs',
  'mv_kpi_blocks_today',
  'mv_kpi_recoveries_month',
  'mv_kpi_cancellations_month',
]);

// Word-boundary patterns for things that must never appear in a query.
// Case-insensitive. These cover both the obvious write paths and a
// pile of less-obvious ones (LISTEN/NOTIFY for pubsub abuse, COPY for
// filesystem read, SET for session state mutation, DO for procedural
// blocks).
const FORBIDDEN_KEYWORDS = [
  'insert', 'update', 'delete', 'drop', 'alter', 'truncate',
  'create', 'grant', 'revoke', 'rename',
  'attach', 'copy', 'vacuum', 'reindex', 'cluster',
  'listen', 'notify', 'unlisten',
  'lock',
  'begin', 'commit', 'rollback', 'savepoint', 'release',
  'set', 'reset',
  'do', 'call', 'execute', 'prepare', 'deallocate', 'discard',
  'load', 'security', 'into',
  'merge', 'refresh',
];

// PII / sensitive column tokens. We block the literal column names
// even when not qualified — a query that references "email" anywhere
// in its text is rejected, full stop.
const PII_TOKENS = [
  'email', 'phone_number', 'phone',
  'first_name', 'last_name', 'full_name', 'display_name',
  'address', 'street', 'city', 'state', 'zip', 'postal',
  'ssn', 'dob', 'date_of_birth',
  'password', 'password_hash',
  'encrypted_payload', 'raw_payload', 'display_value',
  'scam_e164', 'e164',
  'apple_user_id', 'auth_token', 'jwt',
];

export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

/**
 * Validate a single SQL statement. Returns { ok: true } if it passes
 * all checks, otherwise { ok: false, reason: '...' } describing the
 * first failure.
 */
export function validateReadOnlyQuery(rawSql: string): ValidationResult {
  // Strip trailing whitespace + a single optional trailing semicolon.
  let sql = rawSql.trim();
  if (sql.endsWith(';')) sql = sql.slice(0, -1).trim();

  if (sql.length === 0) {
    return { ok: false, reason: 'empty_query' };
  }
  if (sql.length > 4000) {
    return { ok: false, reason: 'query_too_long' };
  }

  // Reject SQL comments to prevent obfuscation tricks like
  //   SELECT 1 -- ; DROP TABLE
  // (which our keyword regex would already catch, but being explicit
  // stops a class of bypass attempts).
  if (/--/.test(sql) || /\/\*/.test(sql)) {
    return { ok: false, reason: 'comments_not_allowed' };
  }

  // Multiple statements check — any unescaped semicolon means the
  // model tried to chain. We already stripped one trailing.
  if (containsUnescapedSemicolon(sql)) {
    return { ok: false, reason: 'multiple_statements' };
  }

  // Must start with SELECT or WITH (after optional whitespace).
  const head = sql.match(/^\s*(\w+)/i);
  if (!head) return { ok: false, reason: 'unparseable' };
  const verb = head[1]!.toLowerCase();
  if (verb !== 'select' && verb !== 'with') {
    return { ok: false, reason: `non_select_statement:${verb}` };
  }

  // Forbidden keyword scan. Word-boundaries catch e.g. "INSERT" but
  // not "inserted_at" (no such column on our tables anyway, but let's
  // be careful). The 'select' verb itself is allowed — we only check
  // forbidden keywords in the NON-leading portion.
  const tail = sql.slice(verb.length);
  for (const kw of FORBIDDEN_KEYWORDS) {
    const re = new RegExp(`\\b${kw}\\b`, 'i');
    if (re.test(tail)) {
      return { ok: false, reason: `forbidden_keyword:${kw}` };
    }
  }

  // PII column scan — if any sensitive token appears, reject. This
  // catches both "SELECT email" and "WHERE email = ...".
  for (const tok of PII_TOKENS) {
    const re = new RegExp(`\\b${tok}\\b`, 'i');
    if (re.test(sql)) {
      return { ok: false, reason: `pii_column:${tok}` };
    }
  }

  // Table allowlist — extract every identifier that follows FROM or
  // JOIN, normalize to lowercase, ensure it's in ALLOWED_TABLES.
  // Subqueries / CTEs that alias an allowed table to a new name are
  // fine because the new name is just an alias; the validator checks
  // the underlying table at the FROM/JOIN site.
  const tableRefs = extractTableRefs(sql);
  if (tableRefs.length === 0) {
    // SELECT 1, SELECT NOW() etc. — no table refs is fine.
    return { ok: true };
  }
  for (const t of tableRefs) {
    if (!ALLOWED_TABLES.has(t)) {
      return { ok: false, reason: `forbidden_table:${t}` };
    }
  }

  return { ok: true };
}

/**
 * Detect a semicolon that terminates a statement (i.e. not inside a
 * 'string' literal). This is approximate but sufficient for the
 * read-only validator — the database is the real backstop.
 */
function containsUnescapedSemicolon(sql: string): boolean {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'" && !inDouble) {
      // Postgres escapes single quotes by doubling: 'don''t'. Skip
      // the second quote so we don't toggle inSingle off mid-literal.
      if (inSingle && sql[i + 1] === "'") {
        i++;
        continue;
      }
      inSingle = !inSingle;
    } else if (c === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (c === ';' && !inSingle && !inDouble) {
      return true;
    }
  }
  return false;
}

function extractTableRefs(sql: string): string[] {
  // Match identifiers after FROM and JOIN. PostgreSQL identifiers may
  // be schema-qualified (public.foo) — we strip the schema and check
  // the bare table name. Quoted identifiers are not supported here;
  // anything quoted gets caught by the quoted-identifier regex below
  // and rejected.
  const out: string[] = [];
  const re = /\b(?:from|join)\s+([a-z_][a-z0-9_.]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const ref = m[1]!.toLowerCase();
    // Skip CTE references that resolved to an alphanumeric ident — a
    // CTE name defined via WITH alpha AS (SELECT ...) FROM alpha is
    // safe because the inner SELECT has been validated separately.
    // For simplicity we still require the reference to either be in
    // the allowlist OR be a bare alias starting with letters that
    // matches a CTE name detected here. Detecting CTE names reliably
    // needs a parser; instead we allowlist all real tables and rely
    // on Claude not inventing fake ones — failed lookups blow up at
    // execute time.
    const bare = ref.includes('.') ? ref.split('.').pop()! : ref;
    out.push(bare);
  }
  // Reject schema-qualified refs other than to public schema by
  // scanning the original captures.
  const schemaRe = /\b(?:from|join)\s+([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)/gi;
  let sm: RegExpExecArray | null;
  while ((sm = schemaRe.exec(sql)) !== null) {
    const schema = sm[1]!.toLowerCase();
    if (schema !== 'public') {
      out.push(`__bad_schema__:${schema}`);
    }
  }
  // Reject any quoted identifiers — those are escape attempts, not
  // legitimate use.
  if (/"[^"]+"/.test(sql)) out.push('__quoted_ident__');
  return out;
}
