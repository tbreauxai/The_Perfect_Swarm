#!/usr/bin/env node

/**
 * Morning Slate Render Cron Runner
 * Calls POST /api/swarm/morning on the Render app using app token authorization.
 */

const baseUrl = process.env.SWARM_BASE_URL || 'https://the-perfect-swarm.onrender.com';
let token = process.env.SWARM_APP_TOKEN;

if (!token && process.env.SWARM_APP_TOKENS) {
  const raw = process.env.SWARM_APP_TOKENS.trim();
  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw);
      token = parsed.duelodds || Object.values(parsed)[0];
    } catch {
      // ignore
    }
  } else {
    for (const part of raw.split(',')) {
      const piece = part.trim();
      const splitAt = piece.indexOf(':');
      if (splitAt > 0) {
        const appId = piece.slice(0, splitAt).trim();
        const t = piece.slice(splitAt + 1).trim();
        if (appId === 'duelodds' || !token) {
          token = t;
        }
      }
    }
  }
}

async function run() {
  const url = `${baseUrl.replace(/\/+$/, '')}/api/swarm/morning`;
  console.log(`[Morning Cron] Triggering morning slate: ${url}`);

  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'ThePerfectSwarm-Cron/1.0'
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  } else {
    console.warn('[Morning Cron] Warning: SWARM_APP_TOKEN is not set.');
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({})
    });

    const status = res.status;
    const data = await res.json().catch(() => ({}));
    console.log(`[Morning Cron] Completed with status ${status}:`, JSON.stringify(data, null, 2));

    if (!res.ok) {
      console.error(`[Morning Cron] Request returned error status ${status}`);
      process.exit(1);
    }

    if (data.errors && data.errors.length > 0) {
      console.warn(`[Morning Cron] Finished with ${data.errors.length} game error(s):`, data.errors);
    }
  } catch (err) {
    console.error('[Morning Cron] Fatal error calling morning slate:', err);
    process.exit(1);
  }
}

run();
