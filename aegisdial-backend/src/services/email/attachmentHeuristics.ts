// Email Shield — deterministic attachment heuristics.
//
// VirusTotal integration (live malware hash lookup) is a separate
// follow-up phase — it has quota concerns (500/day on the free
// tier, 4 req/min sustained) that need a cache + budget guard.
// This file ships the deterministic-only signals that don't need
// network: file-type danger, encrypted-archive flag, macro-bearing
// Office types, executable masquerading.
//
// Each heuristic returns an `AttachmentFinding` slice that the
// scorer composes into the final verdict. We never quote the
// filename in the user-facing reason — `filename_hash` is the
// only identifier; surfacing the plaintext filename to the user
// in the reasons array would be a privacy regression vs SMS
// Shield's "no plaintext at rest" posture.

import type { IncomingAttachment } from './types.js';

export interface AttachmentFinding {
  /** Echo of the input attachment id for join-back at the verdict level. */
  attachment_id: string;
  /**
   * Per-attachment threat categories. Multiple may apply
   * simultaneously (e.g., a macro-bearing encrypted ZIP).
   */
  threats: AttachmentThreat[];
  /** Aggregate severity, used by the scorer for cap composition. */
  severity: 'safe' | 'suspicious' | 'fraud';
}

// Adversarial-review M5 fix: `encrypted_archive` was declared in
// the union and severity map but the detector body never fired it
// (the byte-inspection logic to detect ZIP encryption flags is
// deferred to P7). Listing it without wiring it was a footgun —
// the operator dashboard would surface a category the engine
// never emits, and a future caller passing it as a triggered
// category would surface to users without any actual evidence.
// Removed from the union now; P7 reintroduces it WITH the
// byte-inspection wire.
export type AttachmentThreat =
  | 'executable_masquerade'         // .exe / .scr / .com / .pif / .cmd dressed up as docs
  | 'macro_bearing_office'          // .docm / .xlsm / .pptm / .dotm
  | 'iso_container'                 // .iso / .img — common malware-delivery wrapper
  | 'lnk_or_shortcut'               // .lnk / .url — Windows shortcuts that point at remote payloads
  | 'html_smuggling';               // .html / .svg attachments — HTML-smuggling payloads

/**
 * Per-threat severity contribution. Composed by the scorer into
 * the final attachment_finding.severity for that attachment.
 */
const THREAT_SEVERITY: Record<AttachmentThreat, 'suspicious' | 'fraud'> = {
  executable_masquerade: 'fraud',
  macro_bearing_office: 'suspicious',
  iso_container: 'fraud',
  lnk_or_shortcut: 'fraud',
  html_smuggling: 'suspicious',
};

const EXECUTABLE_EXTENSIONS = new Set([
  '.exe', '.scr', '.com', '.pif', '.cmd', '.bat', '.ps1', '.vbs', '.js', '.jse',
  '.wsf', '.wsh', '.msi', '.msp', '.hta', '.cpl', '.jar',
]);

const MACRO_OFFICE_TYPES = new Set([
  'application/vnd.ms-word.document.macroenabled.12',     // .docm
  'application/vnd.ms-excel.sheet.macroenabled.12',       // .xlsm
  'application/vnd.ms-powerpoint.presentation.macroenabled.12', // .pptm
  'application/vnd.ms-word.template.macroenabled.12',     // .dotm
  'application/vnd.ms-excel.template.macroenabled.12',    // .xltm
  // Older OLE formats that always carry macros.
  'application/msword',                                   // .doc (assume macro-capable)
  'application/vnd.ms-excel',                             // .xls (assume macro-capable)
]);

const MACRO_OFFICE_EXTENSIONS = new Set([
  '.docm', '.xlsm', '.pptm', '.dotm', '.xltm',
  // Legacy formats — always macro-capable.
  '.doc', '.xls',
]);

const ISO_CONTAINER_TYPES = new Set([
  'application/x-iso9660-image',
  'application/x-iso-image',
]);

const ISO_CONTAINER_EXTENSIONS = new Set([
  '.iso', '.img', '.vhd', '.vhdx',
]);

const HTML_SMUGGLING_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
]);

const HTML_SMUGGLING_EXTENSIONS = new Set([
  '.html', '.htm', '.xhtml', '.svg',
]);

const SHORTCUT_EXTENSIONS = new Set(['.lnk', '.url']);

// We DON'T have plaintext filenames after the provider's hashing —
// `filename_hash` is peppered indexHash(). For heuristics that
// need to inspect the extension, the provider must surface the
// extension in another way. Looking at the IncomingAttachment
// surface: we have `content_type` and `size_bytes`. The
// content_type carries most of the signal. The extension-based
// fallbacks below run against a TEST-ONLY plaintext filename if
// the provider supplied one — in production, only content_type
// is used.
//
// (Future: surface `content_type_resolved` from the provider via
// `file` magic on the first N bytes of the attachment to catch
// `.exe` files renamed to `.pdf`. That requires fetching bytes,
// which is the same code path as the VirusTotal integration —
// land both in P7.)

/**
 * Run the deterministic attachment heuristics against one
 * attachment. Pure function. Returns null when no threats fire
 * (caller filters those out so the scorer only sees actionable
 * findings).
 *
 * The optional `filename_extension` parameter is used by tests
 * to drive extension-based heuristics. In production, the
 * scorer doesn't have access to the plaintext extension (only
 * the peppered hash) — content_type is the operational signal.
 * When the provider WIRES UP plaintext-extension-shadowing in a
 * future phase (Graph + IMAP both have it in raw responses),
 * this parameter becomes the bridge.
 */
export function checkAttachment(
  attachment: IncomingAttachment,
  filename_extension?: string,
): AttachmentFinding | null {
  const threats = new Set<AttachmentThreat>();
  const ct = attachment.content_type.toLowerCase();
  const ext = (filename_extension ?? '').toLowerCase();

  // Executable masquerade — extension- AND content-type-based.
  // content_type='application/x-msdownload' or similar is a real
  // ".exe sent as PDF" signal.
  if (
    /\bapplication\/(x-msdownload|x-ms-installer|vnd\.microsoft\.portable-executable)\b/.test(ct) ||
    EXECUTABLE_EXTENSIONS.has(ext)
  ) {
    threats.add('executable_masquerade');
  }

  // Macro-bearing Office. ZIP-wrapped OOXML files
  // (.docm/.xlsm/.pptm) advertise as the macro-enabled type;
  // .doc/.xls always assume macro-capable.
  if (MACRO_OFFICE_TYPES.has(ct) || MACRO_OFFICE_EXTENSIONS.has(ext)) {
    threats.add('macro_bearing_office');
  }

  // ISO / disk image. Common malware-delivery wrapper because
  // Windows mounts them silently and bypasses Mark-of-the-Web.
  if (ISO_CONTAINER_TYPES.has(ct) || ISO_CONTAINER_EXTENSIONS.has(ext)) {
    threats.add('iso_container');
  }

  // Shortcut files. .lnk pointing at PowerShell with a remote
  // payload URL is a 2024-vintage BEC dropper.
  if (SHORTCUT_EXTENSIONS.has(ext)) {
    threats.add('lnk_or_shortcut');
  }

  // HTML / SVG smuggling. The attachment opens in the browser and
  // a JS payload reconstructs an executable from inlined base64.
  if (HTML_SMUGGLING_TYPES.has(ct) || HTML_SMUGGLING_EXTENSIONS.has(ext)) {
    threats.add('html_smuggling');
  }

  // Encrypted archive detection requires inspecting the file
  // bytes — extension alone (.zip / .rar / .7z) doesn't tell us
  // encryption status. We defer this to the byte-inspection
  // phase (alongside VirusTotal). For now: no flag.

  if (threats.size === 0) return null;

  // Severity composition: 'fraud' wins over 'suspicious'. A
  // macro-bearing encrypted ZIP is 'suspicious' on heuristics
  // (operator should review); a renamed .exe is 'fraud' (block).
  let severity: AttachmentFinding['severity'] = 'safe';
  for (const t of threats) {
    if (THREAT_SEVERITY[t] === 'fraud') {
      severity = 'fraud';
      break;
    }
    severity = 'suspicious';
  }

  return {
    attachment_id: attachment.id,
    threats: [...threats].sort(),
    severity,
  };
}

/**
 * Run the heuristics against every attachment on a message.
 * Returns one finding per attachment that fired at least one
 * threat. Pure function.
 */
export function checkAttachments(
  attachments: IncomingAttachment[],
  /**
   * Parallel array of plaintext filenames if the caller has them
   * (rare — only when extending the provider's surface with
   * `filename_extension`). Production scorer passes [].
   */
  filename_extensions: string[] = [],
): AttachmentFinding[] {
  const out: AttachmentFinding[] = [];
  for (let i = 0; i < attachments.length; i++) {
    const f = checkAttachment(attachments[i]!, filename_extensions[i]);
    if (f) out.push(f);
  }
  return out;
}

/**
 * Human-readable rationale for each threat. Surfaced in the
 * verdict's `explainable_reasons` array. NO filename echo —
 * filenames stay peppered-hashed only.
 */
export function describeAttachmentThreat(threat: AttachmentThreat): string {
  switch (threat) {
    case 'executable_masquerade':
      return 'Email contains an attachment with an executable file type — possible malware dropper.';
    case 'macro_bearing_office':
      return 'Email contains a macro-enabled Office document — commonly used to deliver malware.';
    case 'iso_container':
      return 'Email contains a disk-image attachment (.iso / .img) — bypasses Windows download warnings.';
    case 'lnk_or_shortcut':
      return 'Email contains a Windows shortcut (.lnk / .url) — frequently used to launch remote malware.';
    case 'html_smuggling':
      return 'Email contains an HTML / SVG attachment — possible HTML smuggling payload.';
  }
}
