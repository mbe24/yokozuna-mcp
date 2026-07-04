import { describe, expect, it } from 'vitest';
import {
  deploymentFromApiHost,
  deploymentToApiBase,
  loadConfig,
  normalizeEndpoint,
  normalizeUiBase,
} from '../src/config.js';
import { buildDeepLink } from '../src/sumo/deepLink.js';

const SECRET = 'sUp3rSecretKeyValue';
const baseEnv = { SUMO_ACCESS_ID: 'idXYZ', SUMO_ACCESS_KEY: SECRET };

describe('loadConfig', () => {
  it('fails readably when credentials are missing, without leaking the key', () => {
    let message = '';
    try {
      loadConfig({ SUMO_ACCESS_KEY: SECRET });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('SUMO_ACCESS_ID');
    expect(message).toContain('.env.example');
    expect(message).not.toContain(SECRET);
  });

  it('lists both missing credential vars', () => {
    expect(() => loadConfig({})).toThrow(/SUMO_ACCESS_ID, SUMO_ACCESS_KEY/);
  });

  it('defaults to the EU deployment', () => {
    const cfg = loadConfig({ ...baseEnv });
    expect(cfg.baseUrl).toBe('https://api.eu.sumologic.com/api/');
    expect(cfg.deployment).toBe('eu');
  });

  it('maps us1 to the bare api host', () => {
    const cfg = loadConfig({ ...baseEnv, SUMO_DEPLOYMENT: 'us1' });
    expect(cfg.baseUrl).toBe('https://api.sumologic.com/api/');
  });

  it('SUMO_ENDPOINT overrides deployment and is normalized (host only)', () => {
    const cfg = loadConfig({
      ...baseEnv,
      SUMO_DEPLOYMENT: 'us2',
      SUMO_ENDPOINT: 'https://api.eu.sumologic.com',
    });
    expect(cfg.baseUrl).toBe('https://api.eu.sumologic.com/api/');
    expect(cfg.deployment).toBe('eu'); // derived back from the host for deep links
  });

  it('normalizes endpoint variants to the same base', () => {
    for (const v of [
      'https://api.eu.sumologic.com',
      'https://api.eu.sumologic.com/',
      'https://api.eu.sumologic.com/api',
      'https://api.eu.sumologic.com/api/',
    ]) {
      expect(normalizeEndpoint(v)).toBe('https://api.eu.sumologic.com/api/');
    }
  });

  it('rejects non-https and malformed endpoints', () => {
    expect(() => normalizeEndpoint('http://api.eu.sumologic.com')).toThrow(/https/);
    expect(() => normalizeEndpoint('not a url')).toThrow(/not a valid URL/);
    expect(() => normalizeEndpoint('https://api.eu.sumologic.com/other/path')).toThrow(/path/);
  });

  it('applies documented defaults and accepts overrides', () => {
    const cfg = loadConfig({ ...baseEnv });
    expect(cfg.defaultTimeZone).toBe('UTC');
    expect(cfg.defaultDetail).toBe('compact');
    expect(cfg.defaultLimit).toBe(100);
    expect(cfg.maxMessageChars).toBe(10_000);
    const cfg2 = loadConfig({
      ...baseEnv,
      YOKOZUNA_DEFAULT_DETAIL: 'summary',
      YOKOZUNA_DEFAULT_LIMIT: '50',
      YOKOZUNA_MAX_MESSAGE_CHARS: '2000',
      SUMO_DEFAULT_TIMEZONE: 'Europe/Stockholm',
    });
    expect(cfg2.defaultDetail).toBe('summary');
    expect(cfg2.defaultLimit).toBe(50);
    expect(cfg2.maxMessageChars).toBe(2000);
    expect(cfg2.defaultTimeZone).toBe('Europe/Stockholm');
  });

  it('applies defaults for levelExpr, settleMarginSeconds, and facetDimensions', () => {
    const cfg = loadConfig({ ...baseEnv });
    expect(cfg.levelExpr).toBe('log.levelname');
    expect(cfg.settleMarginSeconds).toBe(180);
    expect(cfg.facetDimensions).toEqual([
      '_sourcecategory',
      '_sourcehost',
      'levelname',
      'status',
      'path',
    ]);
  });

  it('accepts overrides for levelExpr, settleMarginSeconds, and facetDimensions', () => {
    const cfg = loadConfig({
      ...baseEnv,
      YOKOZUNA_LEVEL_EXPR: 'log.severity',
      YOKOZUNA_SETTLE_MARGIN_SECONDS: '60',
      YOKOZUNA_FACET_DIMENSIONS: ' _collector , logger ,, status ',
    });
    expect(cfg.levelExpr).toBe('log.severity');
    expect(cfg.settleMarginSeconds).toBe(60);
    expect(cfg.facetDimensions).toEqual(['_collector', 'logger', 'status']);
  });

  it('applies defaults for maxResponseChars and the keepalive knobs', () => {
    const cfg = loadConfig({ ...baseEnv });
    expect(cfg.maxResponseChars).toBe(200_000);
    expect(cfg.keepaliveIdleMinutes).toBe(10);
    expect(cfg.keepaliveMaxJobs).toBe(20);
  });

  it('accepts overrides for maxResponseChars and the keepalive knobs', () => {
    const cfg = loadConfig({
      ...baseEnv,
      YOKOZUNA_MAX_RESPONSE_CHARS: '50000',
      YOKOZUNA_KEEPALIVE_IDLE_MINUTES: '30',
      YOKOZUNA_KEEPALIVE_MAX_JOBS: '5',
    });
    expect(cfg.maxResponseChars).toBe(50_000);
    expect(cfg.keepaliveIdleMinutes).toBe(30);
    expect(cfg.keepaliveMaxJobs).toBe(5);
  });

  it('rejects an absurdly small response cap', () => {
    expect(() => loadConfig({ ...baseEnv, YOKOZUNA_MAX_RESPONSE_CHARS: '10' })).toThrow(
      /YOKOZUNA_MAX_RESPONSE_CHARS/,
    );
  });

  it('falls back to default facet dimensions when the env value is only separators', () => {
    const cfg = loadConfig({ ...baseEnv, YOKOZUNA_FACET_DIMENSIONS: ' , ' });
    expect(cfg.facetDimensions).toContain('_sourcecategory');
  });

  it('returns a frozen config', () => {
    const cfg = loadConfig({ ...baseEnv });
    expect(Object.isFrozen(cfg)).toBe(true);
  });

  it('defaults uiBaseUrl to the deployment service host', () => {
    expect(loadConfig({ ...baseEnv }).uiBaseUrl).toBe('https://service.eu.sumologic.com');
    expect(loadConfig({ ...baseEnv, SUMO_DEPLOYMENT: 'us1' }).uiBaseUrl).toBe(
      'https://service.sumologic.com',
    );
  });

  it('SUMO_UI_BASE_URL overrides the deep-link host and is normalized to origin', () => {
    const cfg = loadConfig({ ...baseEnv, SUMO_UI_BASE_URL: 'https://myorg.eu.sumologic.com/' });
    expect(cfg.uiBaseUrl).toBe('https://myorg.eu.sumologic.com');
    // API base is unaffected by the UI override.
    expect(cfg.baseUrl).toBe('https://api.eu.sumologic.com/api/');
  });

  it('rejects a non-https SUMO_UI_BASE_URL', () => {
    expect(() => normalizeUiBase('http://myorg.eu.sumologic.com')).toThrow(/https/);
    expect(() => normalizeUiBase('nope')).toThrow(/not a valid URL/);
  });
});

describe('buildDeepLink', () => {
  it('uses the configured UI base (company host) for the link', () => {
    const cfg = loadConfig({ ...baseEnv, SUMO_UI_BASE_URL: 'https://myorg.eu.sumologic.com' });
    const link = buildDeepLink(cfg.uiBaseUrl, 'error', 1_000, 2_000);
    expect(link).toBe(
      'https://myorg.eu.sumologic.com/log-search/create?query=error&startTime=1000&endTime=2000',
    );
  });

  it('omits the link when the UI base is unknown or the range is missing', () => {
    expect(buildDeepLink(undefined, 'q', 1, 2)).toBeUndefined();
    expect(buildDeepLink('https://x.sumologic.com', 'q', undefined, 2)).toBeUndefined();
  });
});

describe('deployment helpers', () => {
  it('maps hosts back to deployment codes', () => {
    expect(deploymentFromApiHost('api.eu.sumologic.com')).toBe('eu');
    expect(deploymentFromApiHost('api.sumologic.com')).toBe('us1');
    expect(deploymentFromApiHost('api.us2.sumologic.com')).toBe('us2');
    expect(deploymentFromApiHost('example.com')).toBeUndefined();
  });

  it('builds api bases for all patterns', () => {
    expect(deploymentToApiBase('jp')).toBe('https://api.jp.sumologic.com/api/');
  });
});
