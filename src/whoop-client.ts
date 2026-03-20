import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';

const TOKEN_PATH = process.env.TOKEN_PATH || '/data/whoop-tokens.json';

interface WhoopTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

function saveTokens(tokens: WhoopTokens): void {
  try {
    const dir = TOKEN_PATH.substring(0, TOKEN_PATH.lastIndexOf('/'));
    if (dir && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
    console.log('[WHOOP] Tokens saved to disk');
  } catch (err) {
    console.error('[WHOOP] Failed to save tokens:', err);
  }
}

function loadTokens(): WhoopTokens | null {
  try {
    if (existsSync(TOKEN_PATH)) {
      const data = readFileSync(TOKEN_PATH, 'utf-8');
      console.log('[WHOOP] Tokens loaded from disk');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('[WHOOP] Failed to load tokens:', err);
  }
  return null;
}

interface WhoopCycle {
  id: number;
  created_at: string;
  updated_at: string;
  start: string;
  end: string | null;
  timezone_offset: string;
  score_state: string;
  score: {
    strain: number;
    kilojoule: number;
    average_heart_rate: number;
    max_heart_rate: number;
  } | null;
}

interface WhoopRecovery {
  cycle_id: number;
  sleep_id: number;
  user_id: number;
  created_at: string;
  updated_at: string;
  score_state: string;
  score: {
    user_calibrating: boolean;
    recovery_score: number;
    resting_heart_rate: number;
    hrv_rmssd_milli: number;
    spo2_percentage: number | null;
    skin_temp_celsius: number | null;
  } | null;
}

interface WhoopSleep {
  id: number;
  user_id: number;
  created_at: string;
  updated_at: string;
  start: string;
  end: string;
  timezone_offset: string;
  nap: boolean;
  score_state: string;
  score: {
    stage_summary: {
      total_in_bed_time_milli: number;
      total_awake_time_milli: number;
      total_no_data_time_milli: number;
      total_light_sleep_time_milli: number;
      total_slow_wave_sleep_time_milli: number;
      total_rem_sleep_time_milli: number;
      sleep_cycle_count: number;
      disturbance_count: number;
    };
    sleep_needed: {
      baseline_milli: number;
      need_from_sleep_debt_milli: number;
      need_from_recent_strain_milli: number;
      need_from_recent_nap_milli: number;
    };
    respiratory_rate: number;
    sleep_performance_percentage: number | null;
    sleep_consistency_percentage: number | null;
    sleep_efficiency_percentage: number | null;
  } | null;
}

interface WhoopWorkout {
  id: number;
  user_id: number;
  created_at: string;
  updated_at: string;
  start: string;
  end: string;
  timezone_offset: string;
  sport_id: number;
  score_state: string;
  score: {
    strain: number;
    average_heart_rate: number;
    max_heart_rate: number;
    kilojoule: number;
    percent_recorded: number;
    distance_meter: number | null;
    altitude_gain_meter: number | null;
    altitude_change_meter: number | null;
    zone_duration: {
      zone_zero_milli: number;
      zone_one_milli: number;
      zone_two_milli: number;
      zone_three_milli: number;
      zone_four_milli: number;
      zone_five_milli: number;
    };
  } | null;
}

export class WhoopClient {
  private tokens: WhoopTokens | null = null;
  private clientId: string;
  private clientSecret: string;
  private redirectUri: string;

  constructor(clientId: string, clientSecret: string, redirectUri: string) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.redirectUri = redirectUri;
  }

  get isAuthenticated(): boolean {
    return this.tokens !== null;
  }

  getAuthUrl(): string {
    const scopes = 'read:recovery read:cycles read:sleep read:workout read:profile read:body_measurement offline';
    return `https://api.prod.whoop.com/oauth/oauth2/auth?client_id=${this.clientId}&redirect_uri=${encodeURIComponent(this.redirectUri)}&response_type=code&scope=${encodeURIComponent(scopes)}&state=whoop_mcp`;
  }

  async exchangeCode(code: string): Promise<void> {
    console.log('[WHOOP] Exchanging authorization code for tokens...');

    const response = await fetch('https://api.prod.whoop.com/oauth/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        redirect_uri: this.redirectUri,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`WHOOP token exchange failed: ${response.status} - ${text}`);
    }

    const data = await response.json() as any;
    this.tokens = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + (data.expires_in * 1000),
    };

    console.log('[WHOOP] Authenticated successfully');
  }

  private async refreshTokens(): Promise<void> {
    if (!this.tokens?.refresh_token) {
      throw new Error('No refresh token available. Please re-authorize.');
    }

    console.log('[WHOOP] Refreshing access token...');

    const response = await fetch('https://api.prod.whoop.com/oauth/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.tokens.refresh_token,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        scope: 'offline',
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      this.tokens = null;
      throw new Error(`WHOOP token refresh failed: ${response.status} - ${text}. Please re-authorize.`);
    }

    const data = await response.json() as any;
    this.tokens = {
      access_token: data.access_token,
      refresh_token: data.refresh_token || this.tokens.refresh_token,
      expires_at: Date.now() + (data.expires_in * 1000),
    };

    console.log('[WHOOP] Token refreshed successfully');
  }

  private async ensureAuth(): Promise<void> {
    if (!this.tokens) {
      throw new Error('Not authenticated. Visit /auth to authorize with WHOOP.');
    }
    if (Date.now() > this.tokens.expires_at - 60000) {
      await this.refreshTokens();
    }
  }

  private async apiRequest<T>(path: string, params?: Record<string, string>): Promise<T> {
    await this.ensureAuth();

    const url = new URL(`https://api.prod.whoop.com/developer/v1${path}`);
    if (params) {
      Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    }

    const response = await fetch(url.toString(), {
      headers: {
        'Authorization': `Bearer ${this.tokens!.access_token}`,
      },
    });

    if (response.status === 401) {
      this.tokens = null;
      await this.ensureAuth();
      const retryResponse = await fetch(url.toString(), {
        headers: {
          'Authorization': `Bearer ${this.tokens!.access_token}`,
        },
      });
      if (!retryResponse.ok) {
        throw new Error(`WHOOP API error: ${retryResponse.status}`);
      }
      return retryResponse.json() as T;
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`WHOOP API error: ${response.status} - ${text}`);
    }

    return response.json() as T;
  }

  async getRecovery(startDate?: string, endDate?: string): Promise<WhoopRecovery[]> {
    const params: Record<string, string> = { limit: '10' };
    if (startDate) params.start = new Date(startDate).toISOString();
    if (endDate) params.end = new Date(endDate).toISOString();

    const data = await this.apiRequest<{ records: WhoopRecovery[] }>('/recovery', params);
    return data.records;
  }

  async getSleep(startDate?: string, endDate?: string): Promise<WhoopSleep[]> {
    const params: Record<string, string> = { limit: '10' };
    if (startDate) params.start = new Date(startDate).toISOString();
    if (endDate) params.end = new Date(endDate).toISOString();

    const data = await this.apiRequest<{ records: WhoopSleep[] }>('/activity/sleep', params);
    return data.records;
  }

  async getCycles(startDate?: string, endDate?: string): Promise<WhoopCycle[]> {
    const params: Record<string, string> = { limit: '10' };
    if (startDate) params.start = new Date(startDate).toISOString();
    if (endDate) params.end = new Date(endDate).toISOString();

    const data = await this.apiRequest<{ records: WhoopCycle[] }>('/cycle', params);
    return data.records;
  }

  async getWorkouts(startDate?: string, endDate?: string): Promise<WhoopWorkout[]> {
    const params: Record<string, string> = { limit: '10' };
    if (startDate) params.start = new Date(startDate).toISOString();
    if (endDate) params.end = new Date(endDate).toISOString();

    const data = await this.apiRequest<{ records: WhoopWorkout[] }>('/activity/workout', params);
    return data.records;
  }

  async getTodaySummary(): Promise<string> {
    try {
      const today = new Date().toISOString().split('T')[0];
      const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

      const [recoveries, sleeps, cycles, workouts] = await Promise.all([
        this.getRecovery(yesterday, today).catch(() => []),
        this.getSleep(yesterday, today).catch(() => []),
        this.getCycles(yesterday, today).catch(() => []),
        this.getWorkouts(yesterday, today).catch(() => []),
      ]);

      const latestRecovery = recoveries[0];
      const latestSleep = sleeps.find(s => !s.nap);
      const latestCycle = cycles[0];

      const lines: string[] = [];
      lines.push(`=== WHOOP Daily Summary (${today}) ===\n`);

      if (latestRecovery?.score) {
        const r = latestRecovery.score;
        lines.push(`RECOVERY: ${r.recovery_score}%`);
        lines.push(`  HRV (rMSSD): ${r.hrv_rmssd_milli.toFixed(1)} ms`);
        lines.push(`  Resting HR: ${r.resting_heart_rate} bpm`);
        if (r.spo2_percentage) lines.push(`  SpO2: ${r.spo2_percentage}%`);
        if (r.skin_temp_celsius) lines.push(`  Skin Temp: ${r.skin_temp_celsius.toFixed(1)}°C`);
        lines.push('');
      } else {
        lines.push('RECOVERY: No data available yet\n');
      }

      if (latestSleep?.score) {
        const s = latestSleep.score;
        const stages = s.stage_summary;
        const totalSleepMs = stages.total_in_bed_time_milli - stages.total_awake_time_milli;
        const totalSleepHrs = (totalSleepMs / 3600000).toFixed(1);
        const neededHrs = (s.sleep_needed.baseline_milli / 3600000).toFixed(1);

        lines.push(`SLEEP:`);
        lines.push(`  Total Sleep: ${totalSleepHrs} hrs (needed: ${neededHrs} hrs)`);
        if (s.sleep_performance_percentage !== null) lines.push(`  Performance: ${s.sleep_performance_percentage}%`);
        if (s.sleep_efficiency_percentage !== null) lines.push(`  Efficiency: ${s.sleep_efficiency_percentage}%`);
        if (s.sleep_consistency_percentage !== null) lines.push(`  Consistency: ${s.sleep_consistency_percentage}%`);
        lines.push(`  Respiratory Rate: ${s.respiratory_rate.toFixed(1)} breaths/min`);
        lines.push(`  REM: ${(stages.total_rem_sleep_time_milli / 3600000).toFixed(1)} hrs`);
        lines.push(`  Deep (SWS): ${(stages.total_slow_wave_sleep_time_milli / 3600000).toFixed(1)} hrs`);
        lines.push(`  Light: ${(stages.total_light_sleep_time_milli / 3600000).toFixed(1)} hrs`);
        lines.push(`  Disturbances: ${stages.disturbance_count}`);
        lines.push('');
      } else {
        lines.push('SLEEP: No data available yet\n');
      }

      if (latestCycle?.score) {
        const c = latestCycle.score;
        lines.push(`STRAIN:`);
        lines.push(`  Day Strain: ${c.strain.toFixed(1)}`);
        lines.push(`  Calories: ${(c.kilojoule * 0.239006).toFixed(0)} kcal`);
        lines.push(`  Avg HR: ${c.average_heart_rate} bpm`);
        lines.push(`  Max HR: ${c.max_heart_rate} bpm`);
        lines.push('');
      } else {
        lines.push('STRAIN: No data available yet\n');
      }

      if (workouts.length > 0) {
        lines.push(`WORKOUTS:`);
        for (const w of workouts) {
          if (w.score) {
            const durationMin = ((new Date(w.end).getTime() - new Date(w.start).getTime()) / 60000).toFixed(0);
            lines.push(`  - Sport ID ${w.sport_id}: ${durationMin} min, strain ${w.score.strain.toFixed(1)}, avg HR ${w.score.average_heart_rate}, max HR ${w.score.max_heart_rate}`);
            if (w.score.zone_duration) {
              const zn = w.score.zone_duration;
              lines.push(`    Zones: Z0=${(zn.zone_zero_milli/60000).toFixed(0)}m, Z1=${(zn.zone_one_milli/60000).toFixed(0)}m, Z2=${(zn.zone_two_milli/60000).toFixed(0)}m, Z3=${(zn.zone_three_milli/60000).toFixed(0)}m, Z4=${(zn.zone_four_milli/60000).toFixed(0)}m, Z5=${(zn.zone_five_milli/60000).toFixed(0)}m`);
            }
          }
        }
        lines.push('');
      }

      return lines.join('\n');
    } catch (error) {
      return `Error fetching WHOOP data: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  }
}
