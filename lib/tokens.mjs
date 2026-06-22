// ─── Token management (multi-token support) ─────────────────────────────────
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { TOKENS_PATH, STATE_DIR, COPILOT_TOKEN_URL, TOKEN_CACHE_PATH } from "./utils.mjs";

export function loadTokens() {
  try {
    if (!existsSync(TOKENS_PATH)) return [];
    const data = JSON.parse(readFileSync(TOKENS_PATH, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}

export function saveTokens(tokens) {
  writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2));
}

export function getTokenType(token) {
  if (token.startsWith("gho_")) return "gho_";
  if (token.startsWith("ghu_")) return "ghu_";
  if (token.startsWith("github_pat_")) return "github_pat_";
  return "unknown";
}

export function maskToken(token) {
  if (!token || token.length <= 8) return token || "";
  return token.slice(0, 8) + "...";
}

// --- Token Management ---
/** Cached default token */
let cachedToken = null;
/** Per-token-name cache: { name → { token, expiresAt, baseUrl, tokenName } } */
const tokenCacheByName = new Map();

export function clearCachedToken() {
  cachedToken = null;
}

export function loadGitHubTokenFromProfiles() {
  const searchPaths = [
    join(STATE_DIR, "agents", "main", "agent", "auth-profiles.json"),
    join(STATE_DIR, "agents", "researcher", "agent", "auth-profiles.json"),
    join(STATE_DIR, "credentials", "auth-profiles.json"),
  ];
  for (const storePath of searchPaths) {
    try {
      const store = JSON.parse(readFileSync(storePath, "utf8"));
      const profile = store.profiles?.["github-copilot:github"];
      if (profile?.type === "token" && profile.token) return profile.token;
    } catch {}
  }
  return process.env.COPILOT_GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
}

/** Returns { token, name } for the active GitHub token. Checks tokens.json first, then falls back. */
export function getActiveGitHubToken() {
  const tokens = loadTokens();
  const active = tokens.find(t => t.active);
  if (active) return { token: active.token, name: active.name };
  const fallback = loadGitHubTokenFromProfiles();
  if (fallback) return { token: fallback, name: "(default)" };
  return { token: "", name: "" };
}

export function deriveBaseUrl(token, endpoints) {
  // Prefer endpoints.api from token exchange response (supports enterprise)
  if (endpoints?.api) return endpoints.api.replace(/\/+$/, "");
  const m = token.match(/(?:^|;)\s*proxy-ep=([^;\s]+)/i);
  if (!m) return "https://api.individual.githubcopilot.com";
  const host = m[1].replace(/^https?:\/\//, "").replace(/^proxy\./i, "api.");
  return `https://${host}`;
}

/** Exchange a GitHub token for a Copilot API token. Raw helper (no caching). */
export async function exchangeGitHubToken(githubToken, tokenName) {
  if (!githubToken) throw new Error("No GitHub token found");
  const res = await fetch(COPILOT_TOKEN_URL, {
    headers: { Accept: "application/json", Authorization: `Bearer ${githubToken}` },
  });
  if (!res.ok) throw new Error(`Token exchange failed: HTTP ${res.status}`);
  const data = await res.json();
  const expiresAt = typeof data.expires_at === "number"
    ? (data.expires_at < 1e11 ? data.expires_at * 1000 : data.expires_at)
    : parseInt(data.expires_at, 10) * (parseInt(data.expires_at, 10) < 1e11 ? 1000 : 1);
  const result = { token: data.token, expiresAt, baseUrl: deriveBaseUrl(data.token, data.endpoints), tokenName };
  console.log(`🔗 Token exchanged — base URL: ${result.baseUrl} (token: ${tokenName})`);
  return result;
}

/** Get a Copilot API token by token name (from tokens.json). Uses per-name cache. */
export async function getTokenByName(name) {
  const cached = tokenCacheByName.get(name);
  if (cached && cached.expiresAt - Date.now() > 300_000) return cached;
  const tokens = loadTokens();
  const target = tokens.find(t => t.name === name);
  if (!target) throw new Error(`Token "${name}" not found in tokens.json`);
  const result = await exchangeGitHubToken(target.token, name);
  tokenCacheByName.set(name, result);
  return result;
}

export async function getToken() {
  if (cachedToken && cachedToken.expiresAt - Date.now() > 300_000) return cachedToken;
  const { token: githubToken, name: tokenName } = getActiveGitHubToken();
  // Only use file-based cache when using default token (not tokens.json)
  if (tokenName === "(default)") {
    try {
      const cached = JSON.parse(readFileSync(TOKEN_CACHE_PATH, "utf8"));
      if (cached.token && cached.expiresAt - Date.now() > 300_000) {
        cachedToken = { token: cached.token, expiresAt: cached.expiresAt, baseUrl: deriveBaseUrl(cached.token), tokenName };
        return cachedToken;
      }
    } catch {}
  }
  cachedToken = await exchangeGitHubToken(githubToken, tokenName);
  return cachedToken;
}

/** Returns the active token name and cached copilot token expiry status without network calls. */
export function getCachedTokenInfo() {
  const { name } = getActiveGitHubToken();
  const cached = (name && tokenCacheByName.get(name)) || cachedToken;
  let expiry_status = 'unknown';
  if (cached && cached.expiresAt) {
    expiry_status = cached.expiresAt > Date.now() ? 'valid' : 'expired';
  }
  return { name: name || null, expiry_status };
}

// ─── Load Balancer ───────────────────────────────────────────────────────────
/** Round-robin index */
let lbIndex = 0;
/** Token health: { name → { healthy: bool, unhealthyUntil: timestamp } } */
const tokenHealth = new Map();
/** Request counts per token: { name → count } */
const tokenRequestCounts = new Map();
/** Unhealthy recovery time (5 minutes) */
const UNHEALTHY_TTL = 5 * 60 * 1000;

/** Get all tokens eligible for load balancing (active=true or no active field) */
function getEligibleTokens() {
  const tokens = loadTokens();
  // Include tokens where active is true, undefined, or not present
  return tokens.filter(t => t.active !== false && t.token);
}

/** Check if a token is healthy */
function isTokenHealthy(name) {
  const health = tokenHealth.get(name);
  if (!health) return true;
  if (!health.healthy && health.unhealthyUntil && Date.now() > health.unhealthyUntil) {
    // Recovery time passed, mark as healthy again
    health.healthy = true;
    console.log(`🔄 Token "${name}" recovered, marking healthy`);
  }
  return health.healthy;
}

/** Mark a token as unhealthy */
export function markTokenUnhealthy(name) {
  tokenHealth.set(name, { healthy: false, unhealthyUntil: Date.now() + UNHEALTHY_TTL });
  console.log(`⚠️ Token "${name}" marked unhealthy for ${UNHEALTHY_TTL / 1000}s`);
}

/** Mark a token as healthy */
export function markTokenHealthy(name) {
  tokenHealth.set(name, { healthy: true, unhealthyUntil: null });
}

/** Increment request count for a token */
export function incrementTokenRequestCount(name) {
  tokenRequestCounts.set(name, (tokenRequestCounts.get(name) || 0) + 1);
}

/** Get token stats for dashboard */
export function getTokenStats() {
  const tokens = loadTokens();
  return tokens.map(t => ({
    name: t.name,
    username: t.username,
    active: t.active !== false,
    healthy: isTokenHealthy(t.name),
    requestCount: tokenRequestCounts.get(t.name) || 0,
    cached: tokenCacheByName.has(t.name),
  }));
}

/**
 * Get a Copilot API token using round-robin load balancing.
 * Falls back to next healthy token if current is unhealthy.
 * @returns {Promise<{token, expiresAt, baseUrl, tokenName}>}
 */
export async function getTokenLB() {
  const eligible = getEligibleTokens();
  
  // Fallback to single-token mode if no eligible tokens
  if (eligible.length === 0) {
    console.log("⚡ No eligible tokens for LB, falling back to getToken()");
    return getToken();
  }
  
  // If only one token, skip LB logic
  if (eligible.length === 1) {
    const t = eligible[0];
    incrementTokenRequestCount(t.name);
    return getTokenByName(t.name);
  }
  
  // Round-robin with health check
  const startIndex = lbIndex;
  let attempts = 0;
  
  while (attempts < eligible.length) {
    const idx = lbIndex % eligible.length;
    lbIndex = (lbIndex + 1) % eligible.length;
    const candidate = eligible[idx];
    
    if (isTokenHealthy(candidate.name)) {
      try {
        const result = await getTokenByName(candidate.name);
        incrementTokenRequestCount(candidate.name);
        return result;
      } catch (err) {
        console.error(`❌ Token "${candidate.name}" exchange failed: ${err.message}`);
        markTokenUnhealthy(candidate.name);
      }
    }
    attempts++;
  }
  
  // All tokens unhealthy, try the original one anyway
  console.log("⚠️ All tokens unhealthy, trying first eligible anyway");
  const fallback = eligible[startIndex % eligible.length];
  incrementTokenRequestCount(fallback.name);
  return getTokenByName(fallback.name);
}
