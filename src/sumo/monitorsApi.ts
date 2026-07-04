import type { SumoClient } from '../http/sumoClient.js';

/**
 * Read-only slice of the Monitors management API (GET /v1/monitors/search).
 * Live-verified (EU, 2026-07-03): the search endpoint returns an ARRAY of
 * { path, item } hits; `item.status` is an array of trigger states (e.g. ["Normal"]);
 * notifications carry a connectionType; requires the View Monitors capability
 * (a key without it gets 403).
 */

export interface MonitorNotification {
  notification?: { connectionType?: string; connectionId?: string };
  runForTriggerTypes?: string[];
}

export interface MonitorItem {
  id?: string;
  name?: string;
  description?: string;
  monitorType?: string;
  isDisabled?: boolean;
  status?: string[];
  notifications?: MonitorNotification[];
  triggers?: { triggerType?: string }[];
}

export interface MonitorSearchHit {
  path?: string;
  item?: MonitorItem;
}

export class MonitorsApi {
  constructor(private readonly client: SumoClient) {}

  /** `query` uses Sumo's monitors-search syntax; callers prepend `type:monitor`. */
  async search(query: string, limit: number, signal?: AbortSignal): Promise<MonitorSearchHit[]> {
    const res = await this.client.request<MonitorSearchHit[]>('GET', 'v1/monitors/search', {
      query: { query, limit },
      signal,
    });
    return Array.isArray(res.body) ? res.body : [];
  }
}
