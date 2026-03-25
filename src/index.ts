import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const PORT = parseInt(process.env.PORT || '3000');
const WHOOP_API_BASE = 'https://api.prod.whoop.com/developer';
const WHOOP_INTERNAL_API = 'https://api.prod.whoop.com';

// ─── Token Management ────────────────────────────────────────────────────────

interface TokenStore {
  access_token: string;
  refresh_token: string;
  expires_at: number; // unix timestamp ms
}

let tokenStore: TokenStore | null = null;

// Internal API token (for healthspan - uses email/password via Cognito)
let internalToken: string | null = null;
let internalTokenExpiresAt: number = 0;

function isTokenExpired(): boolean {
  if (!tokenStore) return true;
  // Refresh 5 minutes before expiry for safety margin
  return Date.now() > tokenStore.expires_at - 5 * 60 * 1000;
}

async function refreshAccessToken(): Promise<string> {
  if (!tokenStore || !tokenStore.refresh_token) {
    throw new Error('No refresh token available. Please re-authorize at /auth');
  }

  const currentRefreshToken = tokenStore.refresh_token;
  const clientId = process.env.WHOOP_CLIENT_ID;
  const clientSecret = process.env.WHOOP_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('WHOOP_CLIENT_ID and WHOOP_CLIENT_SECRET must be set');
  }

  console.log('[AUTH] Refreshing access token...');
  
  // Retry up to 3 times with backoff
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = await fetch('https://api.prod.whoop.com/oauth/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: currentRefreshToken,
          client_id: clientId,
          client_secret: clientSecret,
          scope: 'offline read:recovery read:cycles read:workout read:sleep read:profile read:body_measurement',
        }),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        console.error(`[AUTH] Refresh attempt ${attempt} failed: ${resp.status} ${errText}`);
        if (attempt === 3) {
          // On final failure, clear tokens so user knows to re-auth
          tokenStore = null;
          throw new Error(`Token refresh failed after 3 attempts. Please re-authorize at /auth. Last error: ${resp.status}`);
        }
        await new Promise(r => setTimeout(r, 1000 * attempt)); // backoff
        continue;
      }

      const data = await resp.json() as {
        access_token: string;
        refresh_token: string;
        expires_in: number;
      };

      tokenStore = {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: Date.now() + data.expires_in * 1000,
      };

      console.log(`[AUTH] Token refreshed, expires in ${data.expires_in}s`);
      return tokenStore.access_token;
    } catch (err) {
      if (attempt === 3) throw err;
      console.error(`[AUTH] Refresh attempt ${attempt} error:`, err);
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }

  throw new Error('Token refresh failed');
}

async function getAccessToken(): Promise<string> {
  if (!tokenStore) {
    throw new Error('Not authenticated. Please visit /auth to connect your WHOOP account.');
  }
  if (isTokenExpired()) {
    return refreshAccessToken();
  }
  return tokenStore.access_token;
}

// ─── Internal API Auth (for Healthspan) ──────────────────────────────────────

async function getInternalToken(): Promise<string | null> {
  const email = process.env.WHOOP_EMAIL;
  const password = process.env.WHOOP_PASSWORD;
  if (!email || !password) return null;

  if (internalToken && Date.now() < internalTokenExpiresAt - 60000) {
    return internalToken;
  }

  console.log('[AUTH] Authenticating with internal WHOOP API...');
  try {
    const resp = await fetch('https://api.prod.whoop.com/oauth/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        username: email,
        password: password,
        client_id: 'whoop-web',
        client_secret: '',
      }),
    });

    if (!resp.ok) {
      console.error('[AUTH] Internal auth failed:', resp.status);
      return null;
    }

    const data = await resp.json() as { access_token: string; expires_in: number };
    internalToken = data.access_token;
    internalTokenExpiresAt = Date.now() + data.expires_in * 1000;
    console.log('[AUTH] Internal API authenticated');
    return internalToken;
  } catch (err) {
    console.error('[AUTH] Internal auth error:', err);
    return null;
  }
}

// ─── WHOOP API Helpers ───────────────────────────────────────────────────────

async function whoopFetch(path: string, params?: Record<string, string>): Promise<any> {
  const token = await getAccessToken();
  const url = new URL(`${WHOOP_API_BASE}${path}`);
  if (params) {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  }

  const resp = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (resp.status === 401) {
    // Token may have been revoked - try one refresh
    console.log('[API] Got 401, attempting token refresh...');
    const newToken = await refreshAccessToken();
    const retryResp = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${newToken}` },
    });
    if (!retryResp.ok) {
      throw new Error(`WHOOP API error: ${retryResp.status} ${await retryResp.text()}`);
    }
    return retryResp.json();
  }

  if (!resp.ok) {
    throw new Error(`WHOOP API error: ${resp.status} ${await resp.text()}`);
  }

  return resp.json();
}

async function whoopFetchAll(path: string, params?: Record<string, string>, maxPages = 10): Promise<any[]> {
  const allRecords: any[] = [];
  let nextToken: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    const queryParams: Record<string, string> = { ...params, limit: '25' };
    if (nextToken) queryParams.nextToken = nextToken;

    const data = await whoopFetch(path, queryParams);
    if (data.records) {
      allRecords.push(...data.records);
    }
    if (data.next_token) {
      nextToken = data.next_token;
    } else {
      break;
    }
  }

  return allRecords;
}

// ─── Utility Functions ───────────────────────────────────────────────────────

function msToHours(ms: number): string {
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  return `${hours}h ${minutes}m`;
}

function msToMinutes(ms: number): number {
  return Math.round(ms / 60000);
}

function getDateRange(startDate?: string, endDate?: string): { start: string; end: string } {
  const end = endDate
    ? new Date(endDate + 'T23:59:59.999Z').toISOString()
    : new Date().toISOString();
  const start = startDate
    ? new Date(startDate + 'T00:00:00.000Z').toISOString()
    : new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  return { start, end };
}

function getTrendDateRange(days: number): { start: string; end: string } {
  const end = new Date().toISOString();
  const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  return { start, end };
}

function formatZoneDurations(zones: any): string {
  if (!zones) return 'N/A';
  const lines = [];
  const labels = ['Zone 0 (Rest)', 'Zone 1 (Low)', 'Zone 2 (Moderate)', 'Zone 3 (Elevated)', 'Zone 4 (High)', 'Zone 5 (Max)'];
  const keys = ['zone_zero_milli', 'zone_one_milli', 'zone_two_milli', 'zone_three_milli', 'zone_four_milli', 'zone_five_milli'];
  for (let i = 0; i < keys.length; i++) {
    if (zones[keys[i]] !== undefined) {
      lines.push(`  ${labels[i]}: ${msToMinutes(zones[keys[i]])} min`);
    }
  }
  return lines.join('\n');
}

function computeStats(values: number[]): { avg: number; min: number; max: number; trend: string } {
  if (values.length === 0) return { avg: 0, min: 0, max: 0, trend: 'N/A' };
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const min = Math.min(...values);
  const max = Math.max(...values);
  // Simple trend: compare last 3 vs first 3
  let trend = 'stable';
  if (values.length >= 6) {
    const recent = values.slice(-3).reduce((a, b) => a + b, 0) / 3;
    const earlier = values.slice(0, 3).reduce((a, b) => a + b, 0) / 3;
    const pctChange = ((recent - earlier) / earlier) * 100;
    if (pctChange > 5) trend = `↑ improving (+${pctChange.toFixed(1)}%)`;
    else if (pctChange < -5) trend = `↓ declining (${pctChange.toFixed(1)}%)`;
    else trend = '→ stable';
  }
  return { avg: Math.round(avg * 10) / 10, min: Math.round(min * 10) / 10, max: Math.round(max * 10) / 10, trend };
}

// ─── MCP Server Factory ─────────────────────────────────────────────────────

function createServer(): McpServer {
  const server = new McpServer({
    name: 'whoop-mcp-server',
    version: '2.0.0',
  });

  // ── Tool: Get Today ──────────────────────────────────────────────────────

  server.tool(
    'whoop_get_today',
    'Get today\'s WHOOP summary including recovery score, HRV, RHR, sleep performance, strain, and workouts.',
    {},
    async () => {
      try {
        const today = new Date().toISOString().split('T')[0];
        const { start, end } = getDateRange(today, today);
        const params = { start, end, limit: '1' };

        const [cycles, recoveries, sleeps, workouts] = await Promise.all([
          whoopFetch('/v2/cycle', params),
          whoopFetch('/v2/recovery', params),
          whoopFetch('/v2/activity/sleep', params),
          whoopFetch('/v2/activity/workout', params),
        ]);

        const cycle = cycles.records?.[0];
        const recovery = recoveries.records?.[0];
        const sleep = sleeps.records?.[0];

        let output = `=== WHOOP Daily Summary (${today}) ===\n\n`;

        // Recovery
        if (recovery?.score) {
          const s = recovery.score;
          output += `RECOVERY: ${s.recovery_score}%\n`;
          output += `  HRV (rMSSD): ${s.hrv_rmssd_milli?.toFixed(1)} ms\n`;
          output += `  Resting HR: ${s.resting_heart_rate} bpm\n`;
          output += `  SpO2: ${s.spo2_percentage?.toFixed(1)}%\n`;
          output += `  Skin Temp: ${s.skin_temp_celsius?.toFixed(1)}°C\n`;
          output += `  Calibrating: ${s.user_calibrating ? 'Yes' : 'No'}\n`;
        } else {
          output += 'RECOVERY: No data available yet\n';
        }

        // Sleep
        output += '\n';
        if (sleep?.score) {
          const s = sleep.score;
          const stages = s.stage_summary;
          output += `SLEEP:\n`;
          output += `  Performance: ${s.sleep_performance_percentage}%\n`;
          output += `  Efficiency: ${s.sleep_efficiency_percentage?.toFixed(1)}%\n`;
          output += `  Consistency: ${s.sleep_consistency_percentage}%\n`;
          output += `  Respiratory Rate: ${s.respiratory_rate?.toFixed(1)} breaths/min\n`;
          output += `  Total In Bed: ${msToHours(stages.total_in_bed_time_milli)}\n`;
          output += `  Total Sleep: ${msToHours(stages.total_in_bed_time_milli - stages.total_awake_time_milli)}\n`;
          output += `  Light Sleep: ${msToHours(stages.total_light_sleep_time_milli)}\n`;
          output += `  Deep (SWS): ${msToHours(stages.total_slow_wave_sleep_time_milli)}\n`;
          output += `  REM: ${msToHours(stages.total_rem_sleep_time_milli)}\n`;
          output += `  Awake: ${msToHours(stages.total_awake_time_milli)}\n`;
          output += `  Disturbances: ${stages.disturbance_count}\n`;
          output += `  Sleep Cycles: ${stages.sleep_cycle_count}\n`;
          if (s.sleep_needed) {
            output += `  Sleep Needed (baseline): ${msToHours(s.sleep_needed.baseline_milli)}\n`;
            output += `  Sleep Debt Adjustment: +${msToMinutes(s.sleep_needed.need_from_sleep_debt_milli)} min\n`;
            output += `  Strain Adjustment: +${msToMinutes(s.sleep_needed.need_from_recent_strain_milli)} min\n`;
          }
        } else {
          output += 'SLEEP: No data available yet\n';
        }

        // Strain
        output += '\n';
        if (cycle?.score) {
          const s = cycle.score;
          output += `STRAIN:\n`;
          output += `  Day Strain: ${s.strain?.toFixed(1)}\n`;
          output += `  Calories: ${Math.round(s.kilojoule / 4.184)} kcal (${Math.round(s.kilojoule)} kJ)\n`;
          output += `  Avg HR: ${s.average_heart_rate} bpm\n`;
          output += `  Max HR: ${s.max_heart_rate} bpm\n`;
        } else {
          output += 'STRAIN: No data available yet\n';
        }

        // Workouts
        const wkts = workouts.records || [];
        if (wkts.length > 0) {
          output += `\nWORKOUTS (${wkts.length} today):\n`;
          for (const w of wkts) {
            output += `\n  ${w.sport_name || `Sport ID ${w.sport_id}`}\n`;
            output += `    Time: ${new Date(w.start).toLocaleTimeString()} - ${new Date(w.end).toLocaleTimeString()}\n`;
            if (w.score) {
              output += `    Strain: ${w.score.strain?.toFixed(1)}\n`;
              output += `    Avg HR: ${w.score.average_heart_rate} bpm | Max HR: ${w.score.max_heart_rate} bpm\n`;
              output += `    Calories: ${Math.round(w.score.kilojoule / 4.184)} kcal\n`;
              if (w.score.distance_meter) {
                output += `    Distance: ${(w.score.distance_meter / 1000).toFixed(2)} km (${(w.score.distance_meter * 0.000621371).toFixed(2)} mi)\n`;
              }
              if (w.score.altitude_gain_meter) {
                output += `    Elevation Gain: ${w.score.altitude_gain_meter.toFixed(0)} m (${(w.score.altitude_gain_meter * 3.28084).toFixed(0)} ft)\n`;
              }
              if (w.score.zone_durations) {
                output += `    HR Zones:\n${formatZoneDurations(w.score.zone_durations)}\n`;
              }
            }
          }
        }

        return { content: [{ type: 'text', text: output }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
      }
    }
  );

  // ── Tool: Get Recovery ─────────────────────────────────────────────────────

  server.tool(
    'whoop_get_recovery',
    'Get WHOOP recovery data including recovery score, HRV, RHR, SpO2, and skin temperature. Returns data with trend analysis when fetching multiple days.',
    {
      start_date: z.string().optional().describe('Start date YYYY-MM-DD'),
      end_date: z.string().optional().describe('End date YYYY-MM-DD'),
    },
    async ({ start_date, end_date }) => {
      try {
        const { start, end } = getDateRange(start_date, end_date);
        const records = await whoopFetchAll('/v2/recovery', { start, end });

        if (records.length === 0) {
          return { content: [{ type: 'text', text: 'No recovery data found for this period.' }] };
        }

        let output = `=== WHOOP Recovery Data (${records.length} records) ===\n\n`;

        // Individual records
        for (const r of records.slice(0, 14)) {
          if (!r.score) continue;
          const s = r.score;
          const date = new Date(r.created_at).toISOString().split('T')[0];
          output += `${date}: Recovery ${s.recovery_score}% | HRV ${s.hrv_rmssd_milli?.toFixed(1)}ms | RHR ${s.resting_heart_rate}bpm | SpO2 ${s.spo2_percentage?.toFixed(1)}% | Skin ${s.skin_temp_celsius?.toFixed(1)}°C\n`;
        }

        // Trend analysis
        if (records.length >= 3) {
          const scored = records.filter((r: any) => r.score);
          const recoveryScores = scored.map((r: any) => r.score.recovery_score);
          const hrvs = scored.map((r: any) => r.score.hrv_rmssd_milli).filter(Boolean);
          const rhrs = scored.map((r: any) => r.score.resting_heart_rate).filter(Boolean);

          output += `\n--- TREND ANALYSIS (${scored.length} scored days) ---\n`;
          const recStats = computeStats(recoveryScores);
          output += `Recovery: avg ${recStats.avg}% | min ${recStats.min}% | max ${recStats.max}% | ${recStats.trend}\n`;
          if (hrvs.length >= 3) {
            const hrvStats = computeStats(hrvs);
            output += `HRV: avg ${hrvStats.avg}ms | min ${hrvStats.min}ms | max ${hrvStats.max}ms | ${hrvStats.trend}\n`;
          }
          if (rhrs.length >= 3) {
            const rhrStats = computeStats(rhrs);
            output += `RHR: avg ${rhrStats.avg}bpm | min ${rhrStats.min}bpm | max ${rhrStats.max}bpm | ${rhrStats.trend}\n`;
          }
        }

        return { content: [{ type: 'text', text: output }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
      }
    }
  );

  // ── Tool: Get Sleep ────────────────────────────────────────────────────────

  server.tool(
    'whoop_get_sleep',
    'Get WHOOP sleep data including duration, stages (light/deep/REM), efficiency, performance, consistency, respiratory rate, and sleep debt.',
    {
      start_date: z.string().optional().describe('Start date YYYY-MM-DD'),
      end_date: z.string().optional().describe('End date YYYY-MM-DD'),
    },
    async ({ start_date, end_date }) => {
      try {
        const { start, end } = getDateRange(start_date, end_date);
        const records = await whoopFetchAll('/v2/activity/sleep', { start, end });

        // Filter out naps for main sleep analysis
        const mainSleeps = records.filter((r: any) => !r.nap);
        const naps = records.filter((r: any) => r.nap);

        if (mainSleeps.length === 0) {
          return { content: [{ type: 'text', text: 'No sleep data found for this period.' }] };
        }

        let output = `=== WHOOP Sleep Data (${mainSleeps.length} nights${naps.length > 0 ? `, ${naps.length} naps` : ''}) ===\n\n`;

        for (const s of mainSleeps.slice(0, 14)) {
          if (!s.score) continue;
          const sc = s.score;
          const stages = sc.stage_summary;
          const date = new Date(s.start).toISOString().split('T')[0];
          const totalSleep = stages.total_in_bed_time_milli - stages.total_awake_time_milli;

          output += `${date}:\n`;
          output += `  Performance: ${sc.sleep_performance_percentage}% | Efficiency: ${sc.sleep_efficiency_percentage?.toFixed(1)}% | Consistency: ${sc.sleep_consistency_percentage}%\n`;
          output += `  Total Sleep: ${msToHours(totalSleep)} | In Bed: ${msToHours(stages.total_in_bed_time_milli)}\n`;
          output += `  Light: ${msToHours(stages.total_light_sleep_time_milli)} | Deep: ${msToHours(stages.total_slow_wave_sleep_time_milli)} | REM: ${msToHours(stages.total_rem_sleep_time_milli)}\n`;
          output += `  Respiratory Rate: ${sc.respiratory_rate?.toFixed(1)} | Disturbances: ${stages.disturbance_count} | Cycles: ${stages.sleep_cycle_count}\n`;
          if (sc.sleep_needed) {
            output += `  Sleep Needed: ${msToHours(sc.sleep_needed.baseline_milli)} (baseline) + ${msToMinutes(sc.sleep_needed.need_from_sleep_debt_milli)}min debt + ${msToMinutes(sc.sleep_needed.need_from_recent_strain_milli)}min strain\n`;
          }
          output += '\n';
        }

        // Trends
        if (mainSleeps.length >= 3) {
          const scored = mainSleeps.filter((s: any) => s.score);
          const perfs = scored.map((s: any) => s.score.sleep_performance_percentage);
          const effs = scored.map((s: any) => s.score.sleep_efficiency_percentage).filter(Boolean);
          const totalSleepMins = scored.map((s: any) => {
            const st = s.score.stage_summary;
            return msToMinutes(st.total_in_bed_time_milli - st.total_awake_time_milli);
          });
          const deepMins = scored.map((s: any) => msToMinutes(s.score.stage_summary.total_slow_wave_sleep_time_milli));
          const remMins = scored.map((s: any) => msToMinutes(s.score.stage_summary.total_rem_sleep_time_milli));

          output += `--- TREND ANALYSIS (${scored.length} nights) ---\n`;
          const perfStats = computeStats(perfs);
          output += `Performance: avg ${perfStats.avg}% | ${perfStats.trend}\n`;
          if (effs.length >= 3) {
            const effStats = computeStats(effs);
            output += `Efficiency: avg ${effStats.avg}% | ${effStats.trend}\n`;
          }
          const sleepStats = computeStats(totalSleepMins);
          output += `Total Sleep: avg ${Math.floor(sleepStats.avg / 60)}h ${sleepStats.avg % 60}m | ${sleepStats.trend}\n`;
          const deepStats = computeStats(deepMins);
          output += `Deep Sleep: avg ${deepStats.avg}min | ${deepStats.trend}\n`;
          const remStats = computeStats(remMins);
          output += `REM: avg ${remStats.avg}min | ${remStats.trend}\n`;
        }

        return { content: [{ type: 'text', text: output }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
      }
    }
  );

  // ── Tool: Get Strain ───────────────────────────────────────────────────────

  server.tool(
    'whoop_get_strain',
    'Get WHOOP strain and cycle data including day strain score, calories, average and max heart rate.',
    {
      start_date: z.string().optional().describe('Start date YYYY-MM-DD'),
      end_date: z.string().optional().describe('End date YYYY-MM-DD'),
    },
    async ({ start_date, end_date }) => {
      try {
        const { start, end } = getDateRange(start_date, end_date);
        const records = await whoopFetchAll('/v2/cycle', { start, end });

        if (records.length === 0) {
          return { content: [{ type: 'text', text: 'No strain data found for this period.' }] };
        }

        let output = `=== WHOOP Strain Data (${records.length} days) ===\n\n`;

        for (const c of records.slice(0, 14)) {
          if (!c.score) continue;
          const s = c.score;
          const date = new Date(c.start).toISOString().split('T')[0];
          output += `${date}: Strain ${s.strain?.toFixed(1)} | ${Math.round(s.kilojoule / 4.184)} kcal | Avg HR ${s.average_heart_rate}bpm | Max HR ${s.max_heart_rate}bpm\n`;
        }

        // Trends
        if (records.length >= 3) {
          const scored = records.filter((c: any) => c.score);
          const strains = scored.map((c: any) => c.score.strain);
          const cals = scored.map((c: any) => Math.round(c.score.kilojoule / 4.184));

          output += `\n--- TREND ANALYSIS (${scored.length} days) ---\n`;
          const strainStats = computeStats(strains);
          output += `Strain: avg ${strainStats.avg} | min ${strainStats.min} | max ${strainStats.max} | ${strainStats.trend}\n`;
          const calStats = computeStats(cals);
          output += `Calories: avg ${calStats.avg} kcal | min ${calStats.min} | max ${calStats.max} | ${calStats.trend}\n`;
        }

        return { content: [{ type: 'text', text: output }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
      }
    }
  );

  // ── Tool: Get Workouts ─────────────────────────────────────────────────────

  server.tool(
    'whoop_get_workouts',
    'Get WHOOP workout data including sport type, strain, heart rate zones breakdown, duration, calories, distance, and elevation.',
    {
      start_date: z.string().optional().describe('Start date YYYY-MM-DD'),
      end_date: z.string().optional().describe('End date YYYY-MM-DD'),
    },
    async ({ start_date, end_date }) => {
      try {
        const { start, end } = getDateRange(start_date, end_date);
        const records = await whoopFetchAll('/v2/activity/workout', { start, end });

        if (records.length === 0) {
          return { content: [{ type: 'text', text: 'No workout data found for this period.' }] };
        }

        let output = `=== WHOOP Workouts (${records.length} total) ===\n\n`;

        for (const w of records.slice(0, 20)) {
          const date = new Date(w.start).toISOString().split('T')[0];
          const startTime = new Date(w.start).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
          const durationMs = new Date(w.end).getTime() - new Date(w.start).getTime();

          output += `${date} ${startTime} — ${w.sport_name || `Sport ID ${w.sport_id}`} (${msToHours(durationMs)})\n`;
          
          if (w.score) {
            const s = w.score;
            output += `  Strain: ${s.strain?.toFixed(1)} | Avg HR: ${s.average_heart_rate}bpm | Max HR: ${s.max_heart_rate}bpm\n`;
            output += `  Calories: ${Math.round(s.kilojoule / 4.184)} kcal | Recorded: ${s.percent_recorded}%\n`;
            
            if (s.distance_meter && s.distance_meter > 0) {
              output += `  Distance: ${(s.distance_meter / 1000).toFixed(2)} km (${(s.distance_meter * 0.000621371).toFixed(2)} mi)\n`;
            }
            if (s.altitude_gain_meter && s.altitude_gain_meter > 0) {
              output += `  Elevation: +${s.altitude_gain_meter.toFixed(0)}m (${(s.altitude_gain_meter * 3.28084).toFixed(0)}ft) | Net: ${s.altitude_change_meter?.toFixed(0)}m\n`;
            }
            if (s.zone_durations) {
              output += `  HR Zones:\n${formatZoneDurations(s.zone_durations)}\n`;
            }
          }
          output += '\n';
        }

        return { content: [{ type: 'text', text: output }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
      }
    }
  );

  // ── Tool: Get Trends ───────────────────────────────────────────────────────

  server.tool(
    'whoop_get_trends',
    'Get 7/14/30-day rolling trend analysis for recovery, sleep, strain, and workouts. Includes averages, ranges, and directional trends.',
    {
      period: z.enum(['7', '14', '30']).optional().describe('Number of days to analyze (default: 7)'),
    },
    async ({ period }) => {
      try {
        const days = parseInt(period || '7');
        const { start, end } = getTrendDateRange(days);
        const params = { start, end };

        const [recoveries, sleeps, cycles, workouts] = await Promise.all([
          whoopFetchAll('/v2/recovery', params),
          whoopFetchAll('/v2/activity/sleep', params),
          whoopFetchAll('/v2/cycle', params),
          whoopFetchAll('/v2/activity/workout', params),
        ]);

        let output = `=== WHOOP ${days}-Day Trends ===\n\n`;

        // Recovery trends
        const scoredRec = recoveries.filter((r: any) => r.score);
        if (scoredRec.length > 0) {
          const recScores = scoredRec.map((r: any) => r.score.recovery_score);
          const hrvs = scoredRec.map((r: any) => r.score.hrv_rmssd_milli).filter(Boolean);
          const rhrs = scoredRec.map((r: any) => r.score.resting_heart_rate).filter(Boolean);
          const spo2s = scoredRec.map((r: any) => r.score.spo2_percentage).filter(Boolean);

          const recStats = computeStats(recScores);
          output += `RECOVERY (${scoredRec.length} days):\n`;
          output += `  Score: avg ${recStats.avg}% | range ${recStats.min}–${recStats.max}% | ${recStats.trend}\n`;
          if (hrvs.length > 0) {
            const hrvStats = computeStats(hrvs);
            output += `  HRV: avg ${hrvStats.avg}ms | range ${hrvStats.min}–${hrvStats.max}ms | ${hrvStats.trend}\n`;
          }
          if (rhrs.length > 0) {
            const rhrStats = computeStats(rhrs);
            output += `  RHR: avg ${rhrStats.avg}bpm | range ${rhrStats.min}–${rhrStats.max}bpm | ${rhrStats.trend}\n`;
          }
          if (spo2s.length > 0) {
            const spo2Stats = computeStats(spo2s);
            output += `  SpO2: avg ${spo2Stats.avg}% | range ${spo2Stats.min}–${spo2Stats.max}%\n`;
          }

          // Distribution
          const green = recScores.filter((s: number) => s >= 67).length;
          const yellow = recScores.filter((s: number) => s >= 34 && s < 67).length;
          const red = recScores.filter((s: number) => s < 34).length;
          output += `  Distribution: 🟢 ${green} green | 🟡 ${yellow} yellow | 🔴 ${red} red\n`;
        }

        // Sleep trends
        const mainSleeps = sleeps.filter((s: any) => !s.nap && s.score);
        if (mainSleeps.length > 0) {
          const perfs = mainSleeps.map((s: any) => s.score.sleep_performance_percentage);
          const totalMins = mainSleeps.map((s: any) => {
            const st = s.score.stage_summary;
            return msToMinutes(st.total_in_bed_time_milli - st.total_awake_time_milli);
          });
          const deepMins = mainSleeps.map((s: any) => msToMinutes(s.score.stage_summary.total_slow_wave_sleep_time_milli));
          const remMins = mainSleeps.map((s: any) => msToMinutes(s.score.stage_summary.total_rem_sleep_time_milli));

          output += `\nSLEEP (${mainSleeps.length} nights):\n`;
          const perfStats = computeStats(perfs);
          output += `  Performance: avg ${perfStats.avg}% | ${perfStats.trend}\n`;
          const sleepStats = computeStats(totalMins);
          output += `  Duration: avg ${Math.floor(sleepStats.avg / 60)}h ${Math.round(sleepStats.avg % 60)}m | range ${Math.floor(sleepStats.min / 60)}h ${Math.round(sleepStats.min % 60)}m – ${Math.floor(sleepStats.max / 60)}h ${Math.round(sleepStats.max % 60)}m\n`;
          const deepStats = computeStats(deepMins);
          output += `  Deep (SWS): avg ${deepStats.avg}min | ${deepStats.trend}\n`;
          const remStats = computeStats(remMins);
          output += `  REM: avg ${remStats.avg}min | ${remStats.trend}\n`;
        }

        // Strain trends
        const scoredCycles = cycles.filter((c: any) => c.score);
        if (scoredCycles.length > 0) {
          const strains = scoredCycles.map((c: any) => c.score.strain);
          const cals = scoredCycles.map((c: any) => Math.round(c.score.kilojoule / 4.184));

          output += `\nSTRAIN (${scoredCycles.length} days):\n`;
          const strainStats = computeStats(strains);
          output += `  Day Strain: avg ${strainStats.avg} | range ${strainStats.min}–${strainStats.max} | ${strainStats.trend}\n`;
          const calStats = computeStats(cals);
          output += `  Calories: avg ${calStats.avg} kcal/day | ${calStats.trend}\n`;
        }

        // Workout summary
        if (workouts.length > 0) {
          const sportCounts: Record<string, number> = {};
          let totalWorkoutStrain = 0;
          let totalWorkoutCals = 0;

          for (const w of workouts) {
            const sport = w.sport_name || `Sport ${w.sport_id}`;
            sportCounts[sport] = (sportCounts[sport] || 0) + 1;
            if (w.score) {
              totalWorkoutStrain += w.score.strain || 0;
              totalWorkoutCals += w.score.kilojoule / 4.184 || 0;
            }
          }

          output += `\nWORKOUTS (${workouts.length} sessions in ${days} days):\n`;
          output += `  Frequency: ${(workouts.length / (days / 7)).toFixed(1)}/week\n`;
          output += `  Total Workout Strain: ${totalWorkoutStrain.toFixed(1)}\n`;
          output += `  Total Workout Calories: ${Math.round(totalWorkoutCals)} kcal\n`;
          output += `  Activities: ${Object.entries(sportCounts).map(([k, v]) => `${k} (${v})`).join(', ')}\n`;
        }

        return { content: [{ type: 'text', text: output }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
      }
    }
  );

  // ── Tool: Get Healthspan ───────────────────────────────────────────────────

  server.tool(
    'whoop_get_healthspan',
    'Get WHOOP Healthspan data including WHOOP Age (biological age), Pace of Aging, and the 9 contributing metrics. Requires WHOOP_EMAIL and WHOOP_PASSWORD environment variables.',
    {},
    async () => {
      try {
        const token = await getInternalToken();
        if (!token) {
          return {
            content: [{ type: 'text', text: 'Healthspan requires WHOOP_EMAIL and WHOOP_PASSWORD environment variables (internal API). These are not configured. Add them to your Railway environment variables to enable this feature.' }],
          };
        }

        // Try the internal healthspan endpoint
        const resp = await fetch(`${WHOOP_INTERNAL_API}/api/v1/healthspan`, {
          headers: {
            Authorization: `Bearer ${token}`,
            'User-Agent': 'WHOOP/5.0',
          },
        });

        if (!resp.ok) {
          // Try alternate endpoint
          const resp2 = await fetch(`${WHOOP_INTERNAL_API}/users/me/healthspan`, {
            headers: {
              Authorization: `Bearer ${token}`,
              'User-Agent': 'WHOOP/5.0',
            },
          });

          if (!resp2.ok) {
            return {
              content: [{ type: 'text', text: `Healthspan API returned ${resp.status}. This feature may not be available on your WHOOP membership tier, or the internal API endpoint may have changed. Check that you have WHOOP Peak or Life membership.` }],
            };
          }

          const data = await resp2.json();
          return { content: [{ type: 'text', text: `=== WHOOP Healthspan ===\n\n${JSON.stringify(data, null, 2)}` }] };
        }

        const data = await resp.json() as any;

        let output = '=== WHOOP Healthspan ===\n\n';

        if (data.whoop_age !== undefined) {
          output += `WHOOP Age: ${data.whoop_age?.toFixed(1)} years\n`;
          output += `Chronological Age: ${data.chronological_age?.toFixed(1)} years\n`;
          const diff = (data.whoop_age || 0) - (data.chronological_age || 0);
          output += `Difference: ${diff > 0 ? '+' : ''}${diff.toFixed(1)} years (${diff <= 0 ? 'younger than actual age ✓' : 'older than actual age'})\n`;
        }

        if (data.pace_of_aging !== undefined) {
          output += `\nPace of Aging: ${data.pace_of_aging}x\n`;
          if (data.pace_of_aging <= 0) {
            output += '  → You are aging slower than average (excellent)\n';
          } else if (data.pace_of_aging <= 1) {
            output += '  → You are aging at or below average pace (good)\n';
          } else {
            output += '  → You are aging faster than average\n';
          }
        }

        // Contributors
        if (data.contributors || data.metrics) {
          const metrics = data.contributors || data.metrics;
          output += '\nCONTRIBUTING METRICS:\n';
          if (Array.isArray(metrics)) {
            for (const m of metrics) {
              output += `  ${m.name || m.metric}: ${m.value} ${m.unit || ''} (${m.status || m.impact || 'N/A'})\n`;
            }
          } else {
            output += JSON.stringify(metrics, null, 2) + '\n';
          }
        }

        return { content: [{ type: 'text', text: output }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error fetching healthspan: ${err instanceof Error ? err.message : String(err)}` }] };
      }
    }
  );

  return server;
}

// ─── Express App ─────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// Health check
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    version: '2.0.0',
    authenticated: !!tokenStore,
    token_expires_in: tokenStore ? Math.max(0, Math.round((tokenStore.expires_at - Date.now()) / 1000)) + 's' : null,
    healthspan_available: !!(process.env.WHOOP_EMAIL && process.env.WHOOP_PASSWORD),
    timestamp: new Date().toISOString(),
  });
});

// OAuth flow - initiate
app.get('/auth', (_req, res) => {
  const clientId = process.env.WHOOP_CLIENT_ID;
  const redirectUri = process.env.WHOOP_REDIRECT_URI;
  if (!clientId || !redirectUri) {
    res.status(500).json({ error: 'WHOOP_CLIENT_ID and WHOOP_REDIRECT_URI must be set' });
    return;
  }

  const scopes = 'offline read:recovery read:cycles read:workout read:sleep read:profile read:body_measurement';
  const state = Math.random().toString(36).substring(2, 15);
  const authUrl = `https://api.prod.whoop.com/oauth/oauth2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(scopes)}&state=${state}`;
  
  res.redirect(authUrl);
});

// OAuth callback
app.get('/callback', async (req, res) => {
  const code = req.query.code as string;
  if (!code) {
    res.status(400).json({ error: 'No authorization code received' });
    return;
  }

  const clientId = process.env.WHOOP_CLIENT_ID!;
  const clientSecret = process.env.WHOOP_CLIENT_SECRET!;
  const redirectUri = process.env.WHOOP_REDIRECT_URI!;

  try {
    const resp = await fetch('https://api.prod.whoop.com/oauth/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      res.status(500).json({ error: 'Failed to exchange code', details: errText });
      return;
    }

    const data = await resp.json() as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    tokenStore = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + data.expires_in * 1000,
    };

    console.log('[AUTH] Successfully authenticated with WHOOP');
    res.json({ status: 'success', message: 'WHOOP account connected! You can close this window.' });
  } catch (error) {
    console.error('[AUTH] Error exchanging code:', error);
    res.status(500).json({ error: 'Failed to exchange authorization code', details: String(error) });
  }
});

// MCP endpoint
app.post('/mcp', async (req, res) => {
  try {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('[MCP] Error handling request:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
});

// Method not allowed handlers
app.get('/mcp', (_req, res) => {
  res.writeHead(405).end(JSON.stringify({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed. Use POST for MCP requests.' },
    id: null,
  }));
});

app.delete('/mcp', (_req, res) => {
  res.writeHead(405).end(JSON.stringify({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Session management not supported in stateless mode.' },
    id: null,
  }));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[WHOOP MCP] Server v2.0.0 running on http://0.0.0.0:${PORT}`);
  console.log(`[WHOOP MCP] MCP endpoint: http://0.0.0.0:${PORT}/mcp`);
  console.log(`[WHOOP MCP] Health check: http://0.0.0.0:${PORT}/health`);
  console.log(`[WHOOP MCP] Auth: http://0.0.0.0:${PORT}/auth`);
  console.log(`[WHOOP MCP] Healthspan: ${process.env.WHOOP_EMAIL ? 'enabled' : 'disabled (set WHOOP_EMAIL + WHOOP_PASSWORD)'}`);
});
