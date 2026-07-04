/**
 * Types for the Sumo Logic Search Job API, verified against the live EU API (2026-07-03).
 * Schemas are tolerant/passthrough: the API adds fields over time.
 */

export interface CreateSearchJobRequest {
  query: string;
  /** ISO-8601 (`2026-07-02T18:28:00`) or epoch milliseconds. */
  from: string | number;
  to: string | number;
  timeZone: string;
  byReceiptTime?: boolean;
}

export interface CreateSearchJobResponse {
  id: string;
  link?: { rel: string; href: string };
  warning?: string;
}

/** Known states; the set is OPEN — unknown states must keep the poller polling. */
export const STATE_DONE = 'DONE GATHERING RESULTS';
export const STATE_CANCELLED = 'CANCELLED';
export const STATE_FORCE_PAUSED = 'FORCE PAUSED';

export interface HistogramBucket {
  startTimestamp: number;
  length: number;
  count: number;
  logLevel: string | null;
}

export interface SearchJobStatus {
  state: string;
  messageCount: number;
  recordCount: number;
  pendingWarnings: string[];
  pendingErrors: string[];
  histogramBuckets?: HistogramBucket[];
  // Live extras — tolerated/passed through:
  searchedTimeRange?: unknown;
  showLogLevels?: unknown;
  timeElapsed?: unknown;
  usageDetails?: unknown;
  usageDetailsByMeteringType?: unknown;
  warning?: string;
  [key: string]: unknown;
}

export interface ResultField {
  name: string;
  fieldType: string;
  keyField: boolean;
  userReferenced?: boolean;
}

/** ALL map values are strings, even for long/int fields; `nodrop` yields `""`. */
export interface ResultRow {
  map: Record<string, string>;
}

export interface MessagesPage {
  warning?: string;
  fields: ResultField[];
  messages: ResultRow[];
}

export interface RecordsPage {
  warning?: string;
  fields: ResultField[];
  records: ResultRow[];
}

/** Hard server-side caps (live-verified). */
export const MAX_PAGE_LIMIT = 10_000; // limit>10000 silently returns exactly 10000
export const MAX_TOTAL_MESSAGES = 100_000; // per-search result cap
