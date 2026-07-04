import { describe, expect, it } from 'vitest';
import { SumoClient, type FetchLike } from '../src/http/sumoClient.js';
import { RateLimitExceededError, SumoApiError, WrongEndpointError } from '../src/http/errors.js';
import { RateLimiter } from '../src/http/rateLimiter.js';

const CFG = {
  accessId: 'idA',
  accessKey: 'keyB',
  baseUrl: 'https://api.eu.sumologic.com/api/',
};

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function makeClient(responses: (() => Response)[], recorded: Recorded[] = []) {
  let i = 0;
  const fetchFn: FetchLike = async (url, init) => {
    recorded.push({
      url,
      method: init.method ?? 'GET',
      headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>)),
      body: typeof init.body === 'string' ? init.body : undefined,
    });
    const next = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return next!();
  };
  return new SumoClient(CFG, {
    fetchFn,
    sleep: async () => {},
    random: () => 0,
    limiter: new RateLimiter({ requestsPerSecond: 10_000, maxConcurrent: 100 }),
  });
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

describe('SumoClient', () => {
  it('sends Basic auth, Accept json, and JSON content type on POST', async () => {
    const rec: Recorded[] = [];
    const client = makeClient([json(202, { id: 'J1' })], rec);
    await client.request('POST', 'v1/search/jobs', { body: { query: 'x' } });
    const r = rec[0]!;
    expect(r.headers['Authorization']).toBe(`Basic ${Buffer.from('idA:keyB').toString('base64')}`);
    expect(r.headers['Accept']).toBe('application/json');
    expect(r.headers['Content-Type']).toBe('application/json');
    expect(r.url).toBe('https://api.eu.sumologic.com/api/v1/search/jobs');
  });

  it('retries 429 then succeeds', async () => {
    const rec: Recorded[] = [];
    const client = makeClient(
      [json(429, { code: 'rate.limit.exceeded' }), json(200, { ok: true })],
      rec,
    );
    const res = await client.request<{ ok: boolean }>('GET', 'v1/search/jobs/J1');
    expect(res.body.ok).toBe(true);
    expect(rec.length).toBe(2);
  });

  it('gives up after exhausting 429 retries', async () => {
    const client = makeClient([json(429, {})]);
    await expect(client.request('GET', 'x')).rejects.toBeInstanceOf(RateLimitExceededError);
  });

  it('throws WrongEndpointError naming the detected deployment on 301', async () => {
    const client = makeClient([
      json(
        301,
        { status: 301, code: 'moved' },
        { location: 'https://api.eu.sumologic.com/api/v1/search/jobs' },
      ),
    ]);
    const err = await client.request('POST', 'v1/search/jobs', { body: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(WrongEndpointError);
    expect((err as WrongEndpointError).correctDeployment).toBe('eu');
    expect((err as Error).message).toContain('SUMO_DEPLOYMENT=eu');
  });

  it('maps error bodies to SumoApiError with the namespaced code', async () => {
    const client = makeClient([
      json(400, {
        status: 400,
        id: 'CORR-1',
        code: 'searchjob.query.creation.error',
        message: "Unexpected token 'x' found.",
      }),
    ]);
    const err = (await client.request('POST', 'v1/search/jobs', { body: {} }).catch((e) => e)) as SumoApiError;
    expect(err).toBeInstanceOf(SumoApiError);
    expect(err.code).toBe('searchjob.query.creation.error');
    expect(err.is('query.creation.error')).toBe(true);
    expect(err.message).toContain("Unexpected token 'x' found."); // parser detail verbatim
    expect(err.correlationId).toBe('CORR-1');
  });

  it('adds the keepalive/expiry hint on 404', async () => {
    const client = makeClient([
      json(404, { status: 404, code: 'searchjob.jobid.invalid', message: 'Job ID is invalid.' }),
    ]);
    const err = (await client.request('GET', 'v1/search/jobs/GONE').catch((e) => e)) as SumoApiError;
    expect(err.httpStatus).toBe(404);
    expect(err.message).toMatch(/expired|deleted/);
  });

  it('carries cookies from a create response to follow-up requests', async () => {
    const rec: Recorded[] = [];
    const client = makeClient(
      [
        () =>
          new Response(JSON.stringify({ id: 'J1' }), {
            status: 202,
            headers: [
              ['content-type', 'application/json'],
              ['set-cookie', 'AWSALB=abc123; Expires=X; Path=/'],
              ['set-cookie', 'AWSALBCORS=def456; Path=/; SameSite=None'],
            ],
          }),
        json(200, { state: 'DONE GATHERING RESULTS' }),
      ],
      rec,
    );
    await client.request('POST', 'v1/search/jobs', { body: {} });
    await client.request('GET', 'v1/search/jobs/J1');
    expect(rec[1]!.headers['Cookie']).toBe('AWSALB=abc123; AWSALBCORS=def456');
  });

  it('does NOT retry POST on 5xx but does retry GET/DELETE', async () => {
    const recPost: Recorded[] = [];
    const clientPost = makeClient([json(500, { code: 'internal.error' })], recPost);
    await expect(clientPost.request('POST', 'v1/search/jobs', { body: {} })).rejects.toBeInstanceOf(
      SumoApiError,
    );
    expect(recPost.length).toBe(1); // no retry

    const recGet: Recorded[] = [];
    const clientGet = makeClient([json(500, {}), json(200, { ok: 1 })], recGet);
    await clientGet.request('GET', 'v1/search/jobs/J1');
    expect(recGet.length).toBe(2); // retried once then succeeded

    const recDel: Recorded[] = [];
    const clientDel = makeClient([json(503, {}), json(200, {})], recDel);
    await clientDel.request('DELETE', 'v1/search/jobs/J1');
    expect(recDel.length).toBe(2);
  });

  it('shares one rate limiter across all callers (concurrency cap holds)', async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchFn: FetchLike = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      return new Response('{}', { status: 200 });
    };
    const client = new SumoClient(CFG, {
      fetchFn,
      limiter: new RateLimiter({ requestsPerSecond: 10_000, maxConcurrent: 5 }),
    });
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        client.request('GET', `v1/search/jobs/${i}`, { priority: i % 2 ? 'high' : 'normal' }),
      ),
    );
    expect(peak).toBeLessThanOrEqual(5);
  });

  it('never puts credentials in error messages', async () => {
    const client = makeClient([json(400, { code: 'searchjob.no.query', message: 'No query.' })]);
    const err = (await client.request('POST', 'v1/search/jobs', { body: {} }).catch((e) => e)) as Error;
    expect(err.message).not.toContain('keyB');
    expect(err.message).not.toContain(Buffer.from('idA:keyB').toString('base64'));
  });
});
