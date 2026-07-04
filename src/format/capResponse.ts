/**
 * Whole-response safety cap: no matter what the per-message levers allow, an inline
 * tool response never exceeds `maxChars` (YOKOZUNA_MAX_RESPONSE_CHARS, default 200k).
 * Header/notes lines come FIRST in every tool's output, so truncation only ever eats
 * the tail of the body — counts, cursors, and warnings survive.
 */
export function capResponseText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const over = text.length - maxChars;
  return (
    text.slice(0, maxChars) +
    `\n\n[RESPONSE TRUNCATED: ${over} chars over the ${maxChars}-char inline cap ` +
    `(YOKOZUNA_MAX_RESPONSE_CHARS) — narrow the query, lower limit/detail, or use ` +
    `sumo_export_results to write the full result set to a file.]`
  );
}
