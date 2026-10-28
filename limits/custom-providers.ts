// Direct collectors for coding-plan providers BB does not know about:
// Z.AI GLM Coding Plan and Kimi Code.
//
// BB's system.usageLimits() only covers the providers it ships (claude-code,
// codex, ACP). These two plans are consumed through Anthropic-compatible
// endpoints from CLIs, so their quota is fetched here, straight from the
// plans' own usage endpoints, with credentials read off disk exactly where
// the CLIs keep them. Collection only ever runs inside an explicit refresh
// cycle — in manual mode nothing is requested at all.
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CustomWindow {
  label: string;
  usedPercent: number;
  resetsAt: string | null;
}

export interface CustomUsage {
  status: "ok" | "not_installed" | "unauthenticated" | "expired" | "error";
  message: string | null;
  planLabel: string | null;
  windows: CustomWindow[];
}

const FETCH_TIMEOUT_MS = 15_000;

/** `ZAI_TOKEN=…` from ~/.config/zai/tokens.env (the zclaude shell setup). */
async function readZaiToken(): Promise<string | null> {
  try {
    const text = await readFile(
      join(homedir(), ".config", "zai", "tokens.env"),
      "utf8",
    );
    const match = text.match(
      /^\s*(?:export\s+)?ZAI_TOKEN\s*=\s*["']?([^"'\s#]+)/m,
    );
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

interface KimiCredentials {
  path: string;
  accessToken: string;
  refreshToken: string | null;
  /** Epoch ms, normalized from the file's seconds-or-ms `expires_at`. */
  expiresAtMs: number | null;
  /** The whole parsed file, so a refresh writes unknown fields back. */
  raw: Record<string, unknown>;
}

/**
 * kimi-code CLI credential lookup, in its own documented order. Returns the
 * whole record — the token is short-lived (~1 h) and may need refreshing.
 */
async function readKimiCredentials(): Promise<KimiCredentials | null> {
  const explicit = [
    process.env.KIMI_CODE_CREDENTIALS,
    process.env.KIMI_CREDENTIALS,
  ].filter((path): path is string => path !== undefined);

  const credentialDirs = [
    process.env.KIMI_CODE_HOME === undefined
      ? undefined
      : join(process.env.KIMI_CODE_HOME, "credentials"),
    join(homedir(), ".kimi-code", "credentials"),
  ].filter((dir): dir is string => dir !== undefined);

  const candidates: string[] = [...explicit];
  for (const dir of credentialDirs) {
    let names: string[];
    try {
      names = (await readdir(dir)).filter((name) => name.endsWith(".json"));
    } catch {
      continue;
    }
    // Exact name first, then env-suffixed variants (kimi-code-env-*.json).
    names.sort((a, b) => {
      const exact = (name: string) =>
        (name === "kimi-code.json" ? 0 : name.startsWith("kimi-code") ? 1 : 2);
      return exact(a) - exact(b) || a.localeCompare(b);
    });
    for (const name of names) candidates.push(join(dir, name));
  }

  for (const path of candidates) {
    try {
      const raw = JSON.parse(
        await readFile(path, "utf8"),
      ) as Record<string, unknown>;
      if (typeof raw.access_token !== "string" || raw.access_token === "") {
        continue;
      }
      let expiresAtMs: number | null = null;
      if (typeof raw.expires_at === "number") {
        // The file stores seconds; tolerate ms just in case.
        expiresAtMs = raw.expires_at > 1e12 ? raw.expires_at : raw.expires_at * 1000;
      }
      return {
        path,
        accessToken: raw.access_token,
        refreshToken:
          typeof raw.refresh_token === "string" ? raw.refresh_token : null,
        expiresAtMs,
        raw,
      };
    } catch {
      // try the next candidate
    }
  }
  return null;
}

const KIMI_AUTH_URL = "https://auth.kimi.com/api/oauth/token";
const KIMI_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";

/** A token pair this plugin owns (its own refreshes, its own storage). */
export interface KimiAuth {
  accessToken: string;
  refreshToken: string;
  expiresAtMs: number;
}

/** Where the plugin keeps its Kimi token pair (bb kv storage). */
export interface KimiAuthStore {
  load(): Promise<KimiAuth | null>;
  save(auth: KimiAuth): Promise<void>;
}

/** kimi-code's own client id and token endpoint (as documented by onWatch). */
async function refreshKimiToken(refreshToken: string): Promise<KimiAuth | null> {
  try {
    const response = await fetch(KIMI_AUTH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: KIMI_CLIENT_ID,
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const grant = (await response.json().catch(() => null)) as {
      access_token?: unknown;
      refresh_token?: unknown;
      expires_in?: unknown;
    } | null;
    if (
      typeof grant?.access_token !== "string" ||
      typeof grant.refresh_token !== "string"
    ) {
      return null;
    }
    const expiresIn =
      typeof grant.expires_in === "number" ? grant.expires_in : 900;
    return {
      accessToken: grant.access_token,
      refreshToken: grant.refresh_token,
      expiresAtMs: Date.now() + expiresIn * 1000,
    };
  } catch {
    return null;
  }
}

/** A usable access token: the CLI's fresh file, our stored pair, or a
 * refresh — stored in OUR kv, never written back into the CLI's file. */
async function grantKimiAuth(
  store: KimiAuthStore,
  file: KimiCredentials,
  ignoreStored = false,
): Promise<KimiAuth | null> {
  const usable = (auth: KimiAuth | null): auth is KimiAuth =>
    auth !== null &&
    auth.accessToken !== "" &&
    auth.expiresAtMs > Date.now() + 60_000;

  // The running CLI may have refreshed the file since we last looked.
  const fresh = (await readKimiCredentials()) ?? file;
  if (
    fresh.expiresAtMs !== null &&
    fresh.expiresAtMs > Date.now() + 60_000
  ) {
    return {
      accessToken: fresh.accessToken,
      refreshToken: fresh.refreshToken ?? "",
      expiresAtMs: fresh.expiresAtMs,
    };
  }

  const stored = await store.load().catch(() => null);
  if (!ignoreStored && usable(stored)) return stored;

  const sources = [stored?.refreshToken, fresh.refreshToken].filter(
    (token): token is string => typeof token === "string" && token.length > 0,
  );
  for (const token of sources) {
    const granted = await refreshKimiToken(token);
    if (granted !== null) {
      await store.save(granted).catch(() => undefined);
      return granted;
    }
  }
  return stored;
}

interface FetchResult {
  httpStatus: number;
  body: unknown;
  /** Set when the request itself failed (no HTTP status at all). */
  message?: string;
}

async function fetchJson(
  url: string,
  headers: Record<string, string>,
): Promise<FetchResult> {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const body = response.ok
    ? ((await response.json().catch(() => null)) as unknown)
    : null;
  return { httpStatus: response.status, body };
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function isoFromEpochMs(value: unknown): string | null {
  return typeof value === "number" && Number.isFinite(value)
    ? new Date(value).toISOString()
    : null;
}

function notInstalled(): CustomUsage {
  return {
    status: "not_installed",
    message: null,
    planLabel: null,
    windows: [],
  };
}

function failed(message: string): CustomUsage {
  return { status: "error", message, planLabel: null, windows: [] };
}

interface ZaiLimit {
  type?: unknown;
  percentage?: unknown;
  nextResetTime?: unknown;
}

/**
 * Z.AI GLM Coding Plan: `percentage` is the used share of each window.
 * TOKENS_LIMIT is the coding-plan window; TIME_LIMIT is the MCP-tools lane
 * (search, web-reader, zread) — both are worth a ring.
 */
export async function readZaiUsage(): Promise<CustomUsage> {
  const token = await readZaiToken();
  if (token === null) return notInstalled();

  let result: FetchResult;
  try {
    // z.ai accepts the raw key without a Bearer prefix (verified live).
    result = await fetchJson(
      "https://api.z.ai/api/monitor/usage/quota/limit",
      { Authorization: token, Accept: "application/json" },
    );
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  }

  if (result.httpStatus === 401 || result.httpStatus === 403) {
    return { ...notInstalled(), status: "unauthenticated" };
  }
  if (result.body === null) return failed(`HTTP ${result.httpStatus}`);

  const data = (result.body as { data?: { limits?: unknown; level?: unknown } })
    .data;
  const limits = Array.isArray(data?.limits) ? (data!.limits as ZaiLimit[]) : [];

  const windows: CustomWindow[] = [];
  for (const limit of limits) {
    if (typeof limit.percentage !== "number") continue;
    const label = limit.type === "TIME_LIMIT" ? "MCP tools" : "Coding plan";
    windows.push({
      label,
      usedPercent: clampPercent(limit.percentage),
      resetsAt: isoFromEpochMs(limit.nextResetTime),
    });
  }
  if (windows.length === 0) return failed("no limits reported");

  const level = typeof data?.level === "string" ? data.level : null;
  return {
    status: "ok",
    message: null,
    planLabel: level === null ? null : `Coding ${level}`,
    windows,
  };
}

interface KimiLimit {
  window?: {
    duration?: unknown;
    timeUnit?: unknown;
  } | null;
  detail?: {
    limit?: unknown;
    remaining?: unknown;
    resetTime?: unknown;
  } | null;
}

function numeric(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function kimiWindow(
  label: string,
  detail: KimiLimit["detail"],
): CustomWindow | null {
  const limit = numeric(detail?.limit);
  const remaining = numeric(detail?.remaining);
  if (limit === null || remaining === null || limit <= 0) return null;
  return {
    label,
    usedPercent: clampPercent(100 * (1 - Math.max(0, remaining) / limit)),
    resetsAt:
      typeof detail?.resetTime === "string" ? detail.resetTime : null,
  };
}

/**
 * Kimi Code: top-level `usage` is the 7-day window; `limits[]` entries with
 * `window.duration` 300 (minutes) are the rolling 5-hour window. Counts may
 * arrive as strings, so both shapes are accepted.
 *
 * Access tokens live ~15 minutes and the CLI refreshes lazily, so a stale
 * file is the norm. We keep our own token pair in plugin storage (never
 * written into the CLI's file) and recover once on a 401: the CLI may have
 * just persisted a fresh token, or our pair got rotated server-side.
 */
export async function readKimiUsage(
  store: KimiAuthStore,
): Promise<CustomUsage> {
  const file = await readKimiCredentials();
  if (file === null) return notInstalled();

  let auth = await grantKimiAuth(store, file);
  if (auth === null) return { ...notInstalled(), status: "expired" };

  let result = await fetchUsages(auth.accessToken);
  if (result.httpStatus === 401) {
    const recovered = await grantKimiAuth(store, file, true);
    if (recovered !== null) {
      auth = recovered;
      result = await fetchUsages(auth.accessToken);
    }
  }

  if (result.httpStatus === 401) {
    return { ...notInstalled(), status: "expired" };
  }
  if (result.httpStatus === 0) {
    return failed(result.message ?? "network error");
  }
  if (result.body === null) return failed(`HTTP ${result.httpStatus}`);

  const body = result.body as {
    usage?: KimiLimit["detail"];
    limits?: unknown;
  };

  const windows: CustomWindow[] = [];
  const weekly = kimiWindow("7-day", body.usage);
  if (weekly !== null) windows.push(weekly);

  if (Array.isArray(body.limits)) {
    for (const limit of body.limits as KimiLimit[]) {
      if (numeric(limit.window?.duration) !== 300) continue;
      const rolling = kimiWindow("5-hour", limit.detail);
      if (rolling !== null) windows.push(rolling);
    }
  }

  if (windows.length === 0) return failed("no limits reported");
  return { status: "ok", message: null, planLabel: null, windows };
}

async function fetchUsages(token: string): Promise<FetchResult> {
  try {
    return await fetchJson("https://api.kimi.com/coding/v1/usages", {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    });
  } catch (error) {
    return {
      httpStatus: 0,
      body: null,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
