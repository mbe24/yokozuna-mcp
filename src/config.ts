import os from 'node:os';
import { z } from 'zod';

export const DEPLOYMENTS = [
  'au',
  'ca',
  'ch',
  'de',
  'eu',
  'fed',
  'in',
  'jp',
  'kr',
  'us1',
  'us2',
] as const;
export type Deployment = (typeof DEPLOYMENTS)[number];

export type DetailLevel = 'summary' | 'compact' | 'full' | 'raw';

export interface Config {
  readonly accessId: string;
  readonly accessKey: string;
  /** Normalized API base, always `https://<host>/api/` with trailing slash. */
  readonly baseUrl: string;
  /** Deployment code when known; undefined for unmappable custom endpoints. */
  readonly deployment: Deployment | undefined;
  /** Origin used to build UI deep links (e.g. https://myorg.eu.sumologic.com). Undefined ⇒ omit links. */
  readonly uiBaseUrl: string | undefined;
  readonly defaultTimeZone: string;
  readonly defaultSourceCategory: string | undefined;
  readonly exportDir: string;
  readonly defaultDetail: DetailLevel;
  readonly defaultLimit: number;
  readonly maxMessageChars: number;
  /** sumo_new_since freshness lag (seconds): windows end at now − margin (ingestion settle). */
  readonly settleMarginSeconds: number;
  /** Default dimensions for sumo_facets. `_`-prefixed = native fields, else an absolute JSON path from the `_raw` root. */
  readonly facetDimensions: readonly string[];
  /** Whole-response safety cap (chars) for inline tool results. */
  readonly maxResponseChars: number;
  /** Keepalive: minutes a kept job may sit idle before it is auto-deleted. */
  readonly keepaliveIdleMinutes: number;
  /** Keepalive: max jobs tracked at once; the stalest is evicted beyond this. */
  readonly keepaliveMaxJobs: number;
}

/**
 * Native-only defaults (§10.1): payload-schema dims like `levelname` rendered a
 * misleading `100% (none)` on scopes with other schemas — defaults must assume nothing
 * about the payload.
 */
export const DEFAULT_FACET_DIMENSIONS = ['_sourcecategory', '_sourcehost'] as const;

/** api.sumologic.com for us1, api.<code>.sumologic.com for the rest. */
export function deploymentToApiBase(dep: Deployment): string {
  return dep === 'us1' ? 'https://api.sumologic.com/api/' : `https://api.${dep}.sumologic.com/api/`;
}

/**
 * Default UI origin: service.sumologic.com for us1, service.<code>.sumologic.com for the rest.
 * NOTE: many orgs use a company-specific host (e.g. https://<org>.<deployment>.sumologic.com) — set
 * SUMO_UI_BASE_URL to override this default so deep links point at your actual UI.
 */
export function deploymentToUiBase(dep: Deployment): string {
  return dep === 'us1' ? 'https://service.sumologic.com' : `https://service.${dep}.sumologic.com`;
}

/** Normalize a UI base URL to its https origin (`https://<host>`), removing any path/trailing slash. */
export function normalizeUiBase(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      `SUMO_UI_BASE_URL is not a valid URL: "${raw}". Expected e.g. https://myorg.eu.sumologic.com`,
    );
  }
  if (url.protocol !== 'https:') {
    throw new Error(`SUMO_UI_BASE_URL must use https (got "${url.protocol}//").`);
  }
  return `https://${url.host}`;
}

/** Derive a deployment code from an API host like `api.eu.sumologic.com`, if possible. */
export function deploymentFromApiHost(host: string): Deployment | undefined {
  const m = /^api(?:\.([a-z0-9]+))?\.sumologic\.com$/i.exec(host);
  if (!m) return undefined;
  const code = (m[1] ?? 'us1').toLowerCase();
  return (DEPLOYMENTS as readonly string[]).includes(code) ? (code as Deployment) : undefined;
}

/**
 * Normalize a user-supplied endpoint to `https://<host>/api/`.
 * Accepts values with/without trailing slash and with/without the `/api` suffix.
 */
export function normalizeEndpoint(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      `SUMO_ENDPOINT is not a valid URL: "${raw}". Expected e.g. https://api.eu.sumologic.com/api/`,
    );
  }
  if (url.protocol !== 'https:') {
    throw new Error(`SUMO_ENDPOINT must use https (got "${url.protocol}//").`);
  }
  const path = url.pathname.replace(/\/+$/, '');
  if (path !== '' && path !== '/api') {
    throw new Error(
      `SUMO_ENDPOINT has an unexpected path "${url.pathname}". Use https://<host> or https://<host>/api/`,
    );
  }
  return `https://${url.host}/api/`;
}

const envSchema = z.object({
  SUMO_ACCESS_ID: z.string().min(1).optional(),
  SUMO_ACCESS_KEY: z.string().min(1).optional(),
  SUMO_DEPLOYMENT: z.enum(DEPLOYMENTS).optional(),
  SUMO_ENDPOINT: z.string().min(1).optional(),
  SUMO_UI_BASE_URL: z.string().min(1).optional(),
  SUMO_DEFAULT_TIMEZONE: z.string().min(1).optional(),
  SUMO_DEFAULT_SOURCE_CATEGORY: z.string().min(1).optional(),
  YOKOZUNA_EXPORT_DIR: z.string().min(1).optional(),
  YOKOZUNA_DEFAULT_DETAIL: z.enum(['summary', 'compact', 'full', 'raw']).optional(),
  YOKOZUNA_DEFAULT_LIMIT: z.coerce.number().int().min(1).max(5000).optional(),
  YOKOZUNA_MAX_MESSAGE_CHARS: z.coerce.number().int().min(100).optional(),
  /** REMOVED in 0.2.0 — kept in the schema only to warn loudly instead of silently ignoring. */
  YOKOZUNA_LEVEL_EXPR: z.string().min(1).optional(),
  YOKOZUNA_SETTLE_MARGIN_SECONDS: z.coerce.number().int().min(0).optional(),
  YOKOZUNA_FACET_DIMENSIONS: z.string().min(1).optional(),
  YOKOZUNA_MAX_RESPONSE_CHARS: z.coerce.number().int().min(1000).optional(),
  YOKOZUNA_KEEPALIVE_IDLE_MINUTES: z.coerce.number().int().min(1).optional(),
  YOKOZUNA_KEEPALIVE_MAX_JOBS: z.coerce.number().int().min(1).max(200).optional(),
});

function parseFacetDimensions(raw: string | undefined): string[] {
  const dims = (raw ?? '')
    .split(',')
    .map((d) => d.trim())
    .filter((d) => d !== '');
  return dims.length > 0 ? dims : [...DEFAULT_FACET_DIMENSIONS];
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  onWarning: (message: string) => void = (m) => console.error(m),
): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid yokozuna-mcp configuration:\n${details}\nSee .env.example.`);
  }
  const e = parsed.data;

  const missing: string[] = [];
  if (!e.SUMO_ACCESS_ID) missing.push('SUMO_ACCESS_ID');
  if (!e.SUMO_ACCESS_KEY) missing.push('SUMO_ACCESS_KEY');
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(', ')}.\n` +
        'Provide a Sumo Logic access ID/key pair (read-only service account with the\n' +
        '"Download Search Results" and "View Collectors" capabilities). See .env.example.',
    );
  }

  let baseUrl: string;
  let deployment: Deployment | undefined;
  if (e.SUMO_ENDPOINT) {
    baseUrl = normalizeEndpoint(e.SUMO_ENDPOINT);
    deployment = deploymentFromApiHost(new URL(baseUrl).host);
  } else {
    deployment = e.SUMO_DEPLOYMENT ?? 'eu';
    baseUrl = deploymentToApiBase(deployment);
  }

  const uiBaseUrl = e.SUMO_UI_BASE_URL
    ? normalizeUiBase(e.SUMO_UI_BASE_URL)
    : deployment
      ? deploymentToUiBase(deployment)
      : undefined;

  if (e.YOKOZUNA_LEVEL_EXPR !== undefined) {
    onWarning(
      '[yokozuna-mcp] YOKOZUNA_LEVEL_EXPR was removed in 0.2.0 — severity is auto-detected ' +
        'per scope (disclosed in tool output); use the per-call filter= parameter for ' +
        'overrides. The variable is ignored.',
    );
  }

  return Object.freeze({
    accessId: e.SUMO_ACCESS_ID!,
    accessKey: e.SUMO_ACCESS_KEY!,
    baseUrl,
    deployment,
    uiBaseUrl,
    defaultTimeZone: e.SUMO_DEFAULT_TIMEZONE ?? 'UTC',
    defaultSourceCategory: e.SUMO_DEFAULT_SOURCE_CATEGORY,
    exportDir: e.YOKOZUNA_EXPORT_DIR ?? os.tmpdir(),
    defaultDetail: e.YOKOZUNA_DEFAULT_DETAIL ?? 'compact',
    defaultLimit: e.YOKOZUNA_DEFAULT_LIMIT ?? 100,
    maxMessageChars: e.YOKOZUNA_MAX_MESSAGE_CHARS ?? 10_000,
    settleMarginSeconds: e.YOKOZUNA_SETTLE_MARGIN_SECONDS ?? 180,
    facetDimensions: Object.freeze(parseFacetDimensions(e.YOKOZUNA_FACET_DIMENSIONS)),
    maxResponseChars: e.YOKOZUNA_MAX_RESPONSE_CHARS ?? 200_000,
    keepaliveIdleMinutes: e.YOKOZUNA_KEEPALIVE_IDLE_MINUTES ?? 10,
    keepaliveMaxJobs: e.YOKOZUNA_KEEPALIVE_MAX_JOBS ?? 20,
  });
}
