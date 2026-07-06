/**
 * Flattening of raw Sumo message maps into a single working record.
 * Live-verified facts (EU, 2026-07-03):
 *  - metadata keys are lowercase: _messagetime, _receipttime, _sourcecategory, _sourcehost,
 *    _sourcename, _collector, _loglevel, _raw, _view (no _index);
 *  - `request_id`/`levelname` live ONLY inside `_raw.log.*` — `_raw` must be parsed;
 *  - all map values are strings; `nodrop` fields are `""`;
 *  - `stream:"stderr"` is NOT an error signal — the real level is log.levelname
 *    (`_loglevel` is unreliable: empty on most warnings, and `WARN` vs `WARNING`).
 */

export interface FlatMessage {
  /** All fields: lowercase metadata + flattened `log.*` keys (log keys win on collision). */
  fields: Record<string, string>;
  /** Best-available ISO timestamp. */
  timestamp: string | undefined;
  /**
   * Best-available level: `log.levelname` FIRST (reliable), then `_loglevel`, then `level`.
   * `_loglevel` is empty on ~78% of warnings and uses `WARN` where levelname says `WARNING`.
   * Normalized: uppercased, `WARN` aliased to `WARNING` so counts don't split.
   */
  level: string | undefined;
  requestId: string | undefined;
  sourceCategory: string | undefined;
  /** The human-readable payload (log.message, or raw text fallback). Never truncate by default. */
  message: string;
  raw: string;
}

function tryParseJson(text: string): unknown {
  try {
    const v = JSON.parse(text);
    // Double-encoded JSON: a string that itself parses to an object.
    if (typeof v === 'string') {
      try {
        const inner = JSON.parse(v);
        return typeof inner === 'object' && inner !== null ? inner : v;
      } catch {
        return v;
      }
    }
    return v;
  } catch {
    return undefined;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function epochMsToIso(v: string | undefined): string | undefined {
  if (!v || !/^\d{10,}$/.test(v)) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  try {
    return new Date(n).toISOString();
  } catch {
    return undefined;
  }
}

export function flattenMessage(map: Record<string, string>): FlatMessage {
  const fields: Record<string, string> = { ...map };
  const raw = map['_raw'] ?? '';

  let message = raw;
  const parsed = tryParseJson(raw);
  if (isRecord(parsed)) {
    // Envelope keys (stream, timestamp) — kept, but log.* wins on collisions.
    for (const [k, v] of Object.entries(parsed)) {
      if (k === 'log') continue;
      fields[k] = str(v);
    }
    const log = parsed['log'];
    if (isRecord(log)) {
      for (const [k, v] of Object.entries(log)) {
        fields[k] = str(v);
      }
      if (typeof log['message'] === 'string') message = log['message'];
      else if (log['message'] !== undefined) message = str(log['message']);
    } else if (typeof log === 'string' && log !== '') {
      // Container-runtime envelope with a plain-string payload (e.g. an nginx line
      // inside {"stream","timestamp","log"}): the string IS the message.
      message = log;
    } else if (typeof parsed['message'] === 'string') {
      message = parsed['message'];
    }
  }

  const level = firstNonEmpty(fields['levelname'], fields['_loglevel'], fields['level']);
  const timestamp =
    epochMsToIso(fields['_messagetime']) ??
    firstNonEmpty(fields['timestamp'] && !/^\d+$/.test(fields['timestamp']) ? fields['timestamp'] : undefined) ??
    epochMsToIso(fields['timestamp']);

  return {
    fields,
    timestamp,
    level: normalizeLevel(level),
    requestId: firstNonEmpty(fields['request_id']),
    sourceCategory: firstNonEmpty(fields['_sourcecategory']),
    message,
    raw,
  };
}

/** Uppercase + light aliasing (`WARN` → `WARNING`) so level counts don't split across spellings. */
export function normalizeLevel(v: string | undefined): string | undefined {
  if (v === undefined || v === '') return undefined;
  const up = v.toUpperCase();
  return up === 'WARN' ? 'WARNING' : up;
}

function firstNonEmpty(...vals: (string | undefined)[]): string | undefined {
  for (const v of vals) {
    if (v !== undefined && v !== '') return v;
  }
  return undefined;
}

/**
 * DISPLAY-ONLY float-string coercion (§11.1): some producers emit integral floats
 * ("404.0", "2.0") — render them as "404"/"2" so keys/levels don't split visually.
 * Raw/ndjson-export field values stay verbatim; filtering must match numerically
 * (num(x) = 404), never by string equality.
 */
export function coerceNumericDisplay(v: string): string {
  const m = /^(-?\d+)\.0+$/.exec(v);
  return m ? m[1]! : v;
}

/**
 * Fixed-point rendering for numeric strings (§11.2): "7.15E-4" → "0.000715".
 * Values that are not E-notation numbers pass through untouched.
 */
export function fixedPointNumberDisplay(v: string): string {
  const m = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(v);
  if (!m) return v;
  // String decimal-point shift — no float round-trip, so no precision dross.
  const [, sign, intPart, fracPart = '', expStr] = m;
  const digits = intPart! + fracPart;
  const pointIndex = intPart!.length + Number(expStr);
  let out: string;
  if (pointIndex <= 0) out = `0.${'0'.repeat(-pointIndex)}${digits}`;
  else if (pointIndex >= digits.length) out = digits + '0'.repeat(pointIndex - digits.length);
  else out = `${digits.slice(0, pointIndex)}.${digits.slice(pointIndex)}`;
  out = out.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '').replace(/^0+(\d)/, '$1');
  return sign! + out;
}

/**
 * Digest level DISPLAY fallback (§4.6): when the standard level chain is empty, show the
 * best severity-ish signal the message itself carries — numeric/typed fields (`sev=4`,
 * `Fatal`, `type=exception`) or the matched string token (`[error]`). Pure display +
 * grouping polish from the fixed detection vocabulary; no schema knowledge added.
 */
export function fallbackDigestLevel(flat: FlatMessage): string {
  if (flat.level) return flat.level;
  const sev = flat.fields['severity'];
  if (sev !== undefined && sev !== '') {
    return /^-?\d+(?:\.\d+)?$/.test(sev) ? `sev=${coerceNumericDisplay(sev)}` : sev;
  }
  const type = flat.fields['type'];
  if (type !== undefined && type !== '') return `type=${type}`;
  const lower = flat.raw.toLowerCase();
  if (lower.includes('[error]')) return '[error]';
  if (lower.includes('[crit]')) return '[crit]';
  if (lower.includes('[warn')) return '[warn]';
  if (lower.includes('traceback')) return 'traceback';
  if (lower.includes('exception')) return 'exception';
  return 'UNKNOWN';
}

/** The persistent "enable cookies" body warning is noise on EVERY follow-up response. */
export function isCookieNoiseWarning(w: string | undefined): boolean {
  return !!w && w.startsWith('You must enable cookies');
}
