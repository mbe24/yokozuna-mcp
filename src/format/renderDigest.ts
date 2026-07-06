import { epochMsToIso, fallbackDigestLevel } from './flatten.js';
import { signature } from './formatMessages.js';
import type { FlatMessage } from './flatten.js';

/**
 * Grouping + rendering for sumo_error_digest: messages are grouped by
 * (level, normalized signature) — same normalization as dedupe — and rendered as
 * compact one-line-per-signature digest entries, count-desc.
 */

export interface DigestGroup {
  level: string;
  /** Representative (first-seen) message for the group. */
  message: string;
  count: number;
  firstMs: number;
  lastMs: number;
  /** First non-empty request_id seen (cross-reference handle). */
  requestId: string | undefined;
  /** First _sourcecategory seen. */
  sourceCategory: string | undefined;
}

/**
 * Fold one flattened message into the group map (streaming: no message accumulation).
 * The level column falls back to the message's own severity-ish signal (`sev=4`, `Fatal`,
 * `type=exception`, `[error]`) when the standard level chain is empty (§4.6); the
 * grouping key follows the displayed level.
 */
export function accumulateDigest(
  groups: Map<string, DigestGroup>,
  flat: FlatMessage,
  messageTimeMs: number,
): void {
  const level = fallbackDigestLevel(flat);
  const key = `${level} ${signature(flat.message)}`;
  const g = groups.get(key);
  if (!g) {
    groups.set(key, {
      level,
      message: flat.message,
      count: 1,
      firstMs: messageTimeMs,
      lastMs: messageTimeMs,
      requestId: flat.requestId,
      sourceCategory: flat.sourceCategory,
    });
    return;
  }
  g.count += 1;
  if (messageTimeMs > 0 && (g.firstMs === 0 || messageTimeMs < g.firstMs)) g.firstMs = messageTimeMs;
  if (messageTimeMs > g.lastMs) g.lastMs = messageTimeMs;
  if (g.requestId === undefined && flat.requestId !== undefined) g.requestId = flat.requestId;
  if (g.sourceCategory === undefined && flat.sourceCategory !== undefined) {
    g.sourceCategory = flat.sourceCategory;
  }
}

const MAX_DIGEST_MESSAGE_CHARS = 300;

export interface DigestHeader {
  scanned: number;
  topN: number;
  /** The scan stopped at maxScan / the 100k cap — counts cover the scanned prefix only. */
  truncated: boolean;
}

export function renderDigest(header: DigestHeader, groups: Map<string, DigestGroup>): string {
  const iso = (ms: number) => epochMsToIso(String(ms)) ?? '?';
  const lines: string[] = [];
  lines.push(
    `error digest: scanned ${header.scanned} messages, ` +
      `${groups.size} distinct signatures — top ${Math.min(header.topN, groups.size)}` +
      (header.truncated
        ? ' [TRUNCATED: scan cap hit — counts cover the scanned messages only; raise maxScan or narrow the range]'
        : ''),
  );
  const top = [...groups.values()].sort((a, b) => b.count - a.count).slice(0, header.topN);
  for (const g of top) {
    const msg =
      g.message.length > MAX_DIGEST_MESSAGE_CHARS
        ? `${g.message.slice(0, MAX_DIGEST_MESSAGE_CHARS)}…`
        : g.message;
    const parts = [`×${g.count}`, g.level, `${iso(g.firstMs)}..${iso(g.lastMs)}`];
    // req is the promised cross-ref handle — make its absence explicit (some scopes,
    // e.g. workers, carry no request ids at all).
    parts.push(`req=${g.requestId ?? '—'}`);
    if (g.sourceCategory) parts.push(`[${g.sourceCategory}]`);
    parts.push(msg);
    lines.push(parts.join(' '));
  }
  if (top.length === 0) lines.push('(no matching messages)');
  return lines.join('\n');
}
