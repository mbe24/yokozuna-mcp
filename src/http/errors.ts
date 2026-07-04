import { deploymentFromApiHost } from '../config.js';

/** Body shape of Sumo API errors: `{status, id, code, message}` (id = correlation id). */
export interface SumoErrorBody {
  status?: number;
  id?: string;
  code?: string;
  message?: string;
}

export class SumoApiError extends Error {
  readonly httpStatus: number;
  /** Namespaced Sumo code, e.g. `searchjob.jobid.invalid`. May be empty for non-JSON bodies. */
  readonly code: string;
  /** Correlation id from the error body (NOT the job id). */
  readonly correlationId: string | undefined;

  constructor(httpStatus: number, body: SumoErrorBody | undefined, fallbackMessage: string) {
    let message = body?.message || fallbackMessage;
    if (httpStatus === 404) {
      message +=
        ' (the search job may have expired — jobs are cancelled server-side after a few' +
        ' minutes without any status/results request — or it was already deleted;' +
        ' re-create the job)';
    }
    super(message);
    this.name = 'SumoApiError';
    this.httpStatus = httpStatus;
    this.code = body?.code ?? '';
    this.correlationId = body?.id;
  }

  /** Defensive matcher: exact or suffix match so `searchjob.` namespacing changes don't break us. */
  is(code: string): boolean {
    return this.code === code || this.code.endsWith(`.${code}`);
  }
}

export class WrongEndpointError extends Error {
  readonly correctHost: string | undefined;
  readonly correctDeployment: string | undefined;

  constructor(locationHeader: string | null | undefined) {
    let host: string | undefined;
    try {
      host = locationHeader ? new URL(locationHeader).host : undefined;
    } catch {
      host = undefined;
    }
    const dep = host ? deploymentFromApiHost(host) : undefined;
    const hint = host
      ? ` Your credentials belong to ${host}${dep ? ` — set SUMO_DEPLOYMENT=${dep}` : ''}.`
      : '';
    super(`Sumo API returned 301 Moved: this is the wrong deployment endpoint.${hint}`);
    this.name = 'WrongEndpointError';
    this.correctHost = host;
    this.correctDeployment = dep;
  }
}

export class RateLimitExceededError extends Error {
  constructor(attempts: number) {
    super(`Sumo API rate limit (429) persisted after ${attempts} retries; giving up.`);
    this.name = 'RateLimitExceededError';
  }
}
