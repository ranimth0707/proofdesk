/**
 * Thin typed REST client over the TxLINE data API.
 * Retries once on 401 after renewing the guest JWT.
 */

import { activeNetwork } from "../config.js";
import { makeLog } from "../log.js";
import type { FixturePayload, OddsPayload, ScorePayload } from "../types.js";
import type { AuthManager } from "./auth.js";

const log = makeLog("rest");

export class TxlineRest {
  constructor(private auth: AuthManager) {}

  private async get<T>(pathAndQuery: string): Promise<T> {
    const url = `${activeNetwork().apiBaseUrl}${pathAndQuery}`;
    let res = await fetch(url, { headers: this.auth.headers() });
    if (res.status === 401) {
      await this.auth.renewJwt();
      res = await fetch(url, { headers: this.auth.headers() });
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`GET ${pathAndQuery} → HTTP ${res.status} ${body.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }

  fixturesSnapshot(params?: { competitionId?: number; startEpochDay?: number }): Promise<FixturePayload[]> {
    const q = new URLSearchParams();
    if (params?.competitionId !== undefined) q.set("competitionId", String(params.competitionId));
    if (params?.startEpochDay !== undefined) q.set("startEpochDay", String(params.startEpochDay));
    const qs = q.size ? `?${q}` : "";
    return this.get(`/fixtures/snapshot${qs}`);
  }

  oddsSnapshot(fixtureId: number, asOf?: number): Promise<OddsPayload[]> {
    const qs = asOf ? `?asOf=${asOf}` : "";
    return this.get(`/odds/snapshot/${fixtureId}${qs}`);
  }

  oddsUpdates(fixtureId: number): Promise<OddsPayload[]> {
    return this.get(`/odds/updates/${fixtureId}`);
  }

  scoresSnapshot(fixtureId: number): Promise<ScorePayload[]> {
    return this.get(`/scores/snapshot/${fixtureId}`);
  }

  scoresUpdates(fixtureId: number): Promise<ScorePayload[]> {
    return this.get(`/scores/updates/${fixtureId}`);
  }

  /** Fixtures that started between two weeks and six hours ago. */
  historicalScores(fixtureId: number): Promise<ScorePayload[]> {
    return this.get(`/scores/historical/${fixtureId}`);
  }

  /**
   * Validation proof for observed stats. `seq` MUST be an observed sequence
   * from a real scores record (per TxLINE docs), never synthetic.
   */
  statValidation(fixtureId: number, seq: number, statKeys: number[]): Promise<Record<string, unknown>> {
    return this.get(`/scores/stat-validation?fixtureId=${fixtureId}&seq=${seq}&statKeys=${statKeys.join(",")}`);
  }

  async probe(): Promise<{ ok: boolean; detail: string }> {
    try {
      const fixtures = await this.fixturesSnapshot();
      return { ok: true, detail: `fixtures snapshot returned ${fixtures.length} fixtures` };
    } catch (e) {
      log.warn("probe failed:", e);
      return { ok: false, detail: String(e) };
    }
  }
}
