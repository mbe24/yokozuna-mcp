/**
 * Opt-in integration smoke test against the REAL Sumo Logic API.
 * Skipped unless SUMO_ACCESS_ID / SUMO_ACCESS_KEY are set in the environment.
 * Runs ONE tiny bounded search and verifies the job is cleaned up afterwards.
 *
 *   npm run test:integration
 */
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { SumoClient } from '../../src/http/sumoClient.js';
import { SumoApiError } from '../../src/http/errors.js';
import { SearchJobApi } from '../../src/sumo/searchJobApi.js';
import { waitForCompletion } from '../../src/sumo/lifecycle.js';
import { resolveRange } from '../../src/sumo/time.js';

const hasCreds = !!process.env.SUMO_ACCESS_ID && !!process.env.SUMO_ACCESS_KEY;

describe.skipIf(!hasCreds)('integration smoke (live Sumo API)', () => {
  it('creates a tiny search, fetches results, deletes the job', async () => {
    const config = loadConfig(process.env);
    const client = new SumoClient({
      accessId: config.accessId,
      accessKey: config.accessKey,
      baseUrl: config.baseUrl,
    });
    const api = new SearchJobApi(client);

    const range = resolveRange({ last: '5m' });
    const created = await api.create({
      query: 'error',
      from: range.from,
      to: range.to,
      timeZone: 'UTC',
    });
    expect(created.id).toBeTruthy();

    try {
      const wait = await waitForCompletion(api, created.id, { timeoutMs: 90_000 });
      expect(wait.status.state).toBe('DONE GATHERING RESULTS');
      // Non-aggregate query: /messages must page cleanly (possibly zero results).
      const page = await api.messages(created.id, 0, 5);
      expect(Array.isArray(page.messages)).toBe(true);
    } finally {
      await api.delete(created.id, { tolerateMissing: true });
    }

    // Verify cleanup: the job must be gone.
    const gone = await api.status(created.id).catch((e) => e);
    expect(gone).toBeInstanceOf(SumoApiError);
    expect((gone as SumoApiError).httpStatus).toBe(404);
  });
});
