import type { SumoClient } from '../http/sumoClient.js';
import { SumoApiError } from '../http/errors.js';
import {
  MAX_PAGE_LIMIT,
  type CreateSearchJobRequest,
  type CreateSearchJobResponse,
  type MessagesPage,
  type RecordsPage,
  type SearchJobStatus,
} from './types.js';

const JOBS = 'v1/search/jobs';

export class SearchJobApi {
  constructor(private readonly client: SumoClient) {}

  async create(req: CreateSearchJobRequest, signal?: AbortSignal): Promise<CreateSearchJobResponse> {
    // POST create is never retried on 5xx (an unseen success would leak an untracked job).
    const res = await this.client.request<CreateSearchJobResponse>('POST', JOBS, {
      body: req,
      signal,
    });
    if (!res.body?.id) {
      throw new Error(`Sumo create-job response (HTTP ${res.status}) did not include a job id.`);
    }
    return res.body;
  }

  async status(
    id: string,
    opts: { priority?: 'high' | 'normal'; signal?: AbortSignal } = {},
  ): Promise<SearchJobStatus> {
    const res = await this.client.request<SearchJobStatus>('GET', `${JOBS}/${id}`, {
      priority: opts.priority ?? 'high', // status polls double as keepalive — never starve them
      signal: opts.signal,
    });
    return res.body;
  }

  /** Non-aggregate jobs only; aggregate jobs 400 `searchjob.raw.messages.not.available`. */
  async messages(
    id: string,
    offset: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<MessagesPage> {
    const res = await this.client.request<MessagesPage>('GET', `${JOBS}/${id}/messages`, {
      query: { offset, limit: Math.min(limit, MAX_PAGE_LIMIT) },
      signal,
    });
    return res.body;
  }

  /** Aggregate jobs only; non-aggregate jobs 400 `searchjob.no.records.not.an.aggregation.query`. */
  async records(
    id: string,
    offset: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<RecordsPage> {
    const res = await this.client.request<RecordsPage>('GET', `${JOBS}/${id}/records`, {
      query: { offset, limit: Math.min(limit, MAX_PAGE_LIMIT) },
      signal,
    });
    return res.body;
  }

  /**
   * Delete a job. With `tolerateMissing` (cleanup paths), a 404/`jobid.invalid` is swallowed
   * so cleanup never masks an original error.
   */
  async delete(id: string, opts: { tolerateMissing?: boolean; signal?: AbortSignal } = {}): Promise<void> {
    try {
      await this.client.request('DELETE', `${JOBS}/${id}`, { signal: opts.signal });
    } catch (err) {
      if (
        opts.tolerateMissing &&
        err instanceof SumoApiError &&
        (err.httpStatus === 404 || err.is('jobid.invalid'))
      ) {
        return;
      }
      throw err;
    }
  }
}
