// Reading Codex's own rate-limit snapshot off disk.
//
// BB's system.usageLimits() asks the Codex CLI over the network, which fails
// whenever the machine is offline or ChatGPT's usage endpoint is unhappy. The
// Codex CLI also writes the last snapshot it received into the session rollout
// it is currently appending to, so the newest rollout is a usable offline
// fallback: slightly stale, but real numbers instead of an error chip.
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Bytes read from the tail of a rollout; snapshots sit near the end. */
const TAIL_BYTES = 512 * 1024;

export interface CodexSnapshot {
  planLabel: string | null;
  windows: {
    label: string;
    usedPercent: number;
    resetsAt: string | null;
  }[];
  creditBalance: number | null;
  capturedAt: string;
}

interface RateLimitWindow {
  used_percent?: unknown;
  window_minutes?: unknown;
  resets_at?: unknown;
}

interface RateLimits {
  primary?: RateLimitWindow | null;
  secondary?: RateLimitWindow | null;
  credits?: { balance?: unknown; unlimited?: unknown } | null;
  plan_type?: unknown;
}

/** Newest entry in a directory of numeric name segments (`2026/08/08`). */
async function newestChild(dir: string): Promise<string | null> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const names = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const last = names.at(-1);
  return last === undefined ? null : join(dir, last);
}

/**
 * Newest `rollout-*.jsonl`. Codex nests them as sessions/YYYY/MM/DD/, so this
 * walks the newest branch instead of stat-ing every one of thousands of files.
 */
async function newestRollout(sessionsDir: string): Promise<string | null> {
  const year = await newestChild(sessionsDir);
  if (year === null) return null;
  const month = await newestChild(year);
  if (month === null) return null;
  const day = await newestChild(month);
  if (day === null) return null;

  let entries;
  try {
    entries = await readdir(day);
  } catch {
    return null;
  }
  const files = entries.filter((name) => name.endsWith(".jsonl")).sort();
  const last = files.at(-1);
  return last === undefined ? null : join(day, last);
}

/** Last `{...}` object starting at `"rate_limits":`, matched by brace depth. */
function extractLastRateLimits(text: string): RateLimits | null {
  const marker = '"rate_limits":';
  const start = text.lastIndexOf(marker);
  if (start === -1) return null;

  const objectStart = text.indexOf("{", start + marker.length);
  if (objectStart === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = objectStart; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(objectStart, index + 1)) as RateLimits;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function windowLabel(minutes: number): string {
  if (minutes % (60 * 24) === 0) {
    const days = minutes / (60 * 24);
    return days === 7 ? "Weekly limit" : `${days}d limit`;
  }
  if (minutes % 60 === 0) return `${minutes / 60}h limit`;
  return `${minutes}m limit`;
}

function toWindow(
  raw: RateLimitWindow | null | undefined,
  fallbackLabel: string,
): CodexSnapshot["windows"][number] | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw.used_percent !== "number") return null;

  const minutes =
    typeof raw.window_minutes === "number" ? raw.window_minutes : null;
  const resetsAt =
    typeof raw.resets_at === "number"
      ? new Date(raw.resets_at * 1000).toISOString()
      : null;

  return {
    label: minutes === null ? fallbackLabel : windowLabel(minutes),
    usedPercent: raw.used_percent,
    resetsAt,
  };
}

/** Reads the newest on-disk Codex snapshot, or null when there is none. */
export async function readCodexSnapshot(
  codexHome = join(homedir(), ".codex"),
): Promise<CodexSnapshot | null> {
  const rolloutPath = await newestRollout(join(codexHome, "sessions"));
  if (rolloutPath === null) return null;

  let text: string;
  let capturedAt: string;
  let handle;
  try {
    handle = await open(rolloutPath, "r");
  } catch {
    return null;
  }
  try {
    const info = await handle.stat();
    capturedAt = info.mtime.toISOString();
    const length = Math.min(TAIL_BYTES, info.size);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, info.size - length);
    text = buffer.toString("utf8");
  } catch {
    return null;
  } finally {
    await handle.close();
  }

  const limits = extractLastRateLimits(text);
  if (limits === null) return null;

  const windows = [
    toWindow(limits.primary, "Primary limit"),
    toWindow(limits.secondary, "Secondary limit"),
  ].filter((window): window is CodexSnapshot["windows"][number] =>
    window !== null,
  );
  if (windows.length === 0) return null;

  const rawBalance = limits.credits?.balance;
  const balance =
    typeof rawBalance === "string"
      ? Number.parseFloat(rawBalance)
      : typeof rawBalance === "number"
        ? rawBalance
        : null;

  return {
    planLabel:
      typeof limits.plan_type === "string" && limits.plan_type.length > 0
        ? limits.plan_type
        : null,
    windows,
    creditBalance: balance !== null && Number.isFinite(balance) ? balance : null,
    capturedAt,
  };
}

/** Exported for tests; `stat` is imported so the module owns its fs surface. */
export const __testing = { extractLastRateLimits, windowLabel, stat };
