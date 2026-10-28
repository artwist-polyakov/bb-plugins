// bb-plugin-limits — provider usage limits, as rings in the thread header.
//
// BB already collects per-provider quota through system.usageLimits(); this
// plugin caches that behind a refresh service so several UI surfaces can read
// it without each one hitting the providers, fills Codex in from disk when the
// live fetch fails. Context-window usage is left to BB's own composer
// indicator.
import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";

import { readCodexSnapshot } from "./codex-fallback";
import { readKimiUsage, readZaiUsage } from "./custom-providers";

/** Cache key holding the last snapshot so a reload starts warm. */
const SNAPSHOT_KEY = "snapshot";
/** Realtime channel the frontend subscribes to for refresh signals. */
const CHANNEL = "usage";

/** BB's usage keys, in display order, mapped onto its provider ids. */
const PROVIDERS = [
  { key: "claudeCode", providerId: "claude-code", label: "Claude Code" },
  { key: "codex", providerId: "codex", label: "Codex" },
  { key: "acp-cursor", providerId: "acp-cursor", label: "Cursor" },
] as const;

/**
 * Providers BB does not know about, collected by this plugin directly from
 * the plans' own usage endpoints. Not-installed ones (no credentials on
 * disk) are omitted from the snapshot entirely, so their chips stay hidden.
 */
const CUSTOM_PROVIDERS = [
  {
    providerId: "zai-glm",
    label: "GLM (Z.AI)",
    collect: () => readZaiUsage(),
  },
  {
    providerId: "kimi-coding",
    label: "Kimi Code",
    collect: (bb: BbPluginApi) =>
      readKimiUsage({
        load: async () => (await bb.storage.kv.get("kimiAuth")) ?? null,
        save: (auth) => bb.storage.kv.set("kimiAuth", auth),
      }),
  },
] as const;

const windowSchema = z.object({
  label: z.string(),
  usedPercent: z.number(),
  resetsAt: z.string().nullable(),
  cost: z
    .object({ usedUsdCents: z.number(), limitUsdCents: z.number() })
    .nullable(),
});

const providerSchema = z.object({
  key: z.string(),
  providerId: z.string(),
  label: z.string(),
  status: z.string(),
  message: z.string().nullable(),
  accountEmail: z.string().nullable(),
  planLabel: z.string().nullable(),
  windows: z.array(windowSchema),
  creditBalance: z.number().nullable(),
  /** Set when the numbers came from disk rather than a live fetch. */
  offlineSince: z.string().nullable(),
});

const snapshotSchema = z.object({
  providers: z.array(providerSchema),
  fetchedAt: z.string().nullable(),
  error: z.string().nullable(),
});

export const rpcContract = defineRpcContract({
  snapshot: {
    input: z.null(),
    output: snapshotSchema,
  },
  refresh: {
    input: z.null(),
    output: snapshotSchema,
  },
  refreshProvider: {
    input: z.object({ providerId: z.string() }).strict(),
    output: snapshotSchema,
  },
  threadModel: {
    input: z.object({ threadId: z.string() }).strict(),
    output: z.object({
      model: z.string().nullable(),
      providerId: z.string().nullable(),
    }),
  },
});

type Snapshot = z.infer<typeof snapshotSchema>;
type ProviderUsage = z.infer<typeof providerSchema>;

interface RawWindow {
  label?: unknown;
  usedPercent?: unknown;
  resetsAt?: unknown;
  cost?: { usedUsdCents?: unknown; limitUsdCents?: unknown } | null;
}

interface RawProvider {
  status?: unknown;
  message?: unknown;
  accountEmail?: unknown;
  planLabel?: unknown;
  windows?: unknown;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function normalizeWindows(raw: unknown): ProviderUsage["windows"] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry: RawWindow) => {
    if (typeof entry?.usedPercent !== "number") return [];
    const cost =
      typeof entry.cost?.usedUsdCents === "number" &&
      typeof entry.cost?.limitUsdCents === "number"
        ? {
            usedUsdCents: entry.cost.usedUsdCents,
            limitUsdCents: entry.cost.limitUsdCents,
          }
        : null;
    return [
      {
        label: asString(entry.label) ?? "Limit",
        usedPercent: entry.usedPercent,
        resetsAt: asString(entry.resetsAt),
        cost,
      },
    ];
  });
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    refreshSeconds: {
      type: "select",
      label: "Refresh interval (seconds)",
      description:
        "How often limits re-fetch in the background: 60 = 1 min, 120 = 2 min, 300 = 5 min, 600 = 10 min, 0 = manual only (no background requests at all; refresh from the header dialog).",
      options: ["60", "120", "300", "600", "0"],
      default: "120",
    },
    codexOfflineFallback: {
      type: "boolean",
      label: "Read Codex limits from disk when the live fetch fails",
      default: true,
    },
    showClaudeCode: {
      type: "boolean",
      label: "Header chip — Claude Code",
      default: true,
    },
    showCodex: {
      type: "boolean",
      label: "Header chip — Codex",
      default: true,
    },
    showAcpCursor: {
      type: "boolean",
      label: "Header chip — Cursor",
      default: true,
    },
    showZaiGlm: {
      type: "boolean",
      label: "Header chip — GLM (Z.AI)",
      default: true,
    },
    showKimiCode: {
      type: "boolean",
      label: "Header chip — Kimi Code",
      default: true,
    },
    collapsedProvider: {
      type: "select",
      label: "Collapsed pill fallback",
      description:
        "The collapsed pill follows the open thread: its provider, or the plan its model runs on (a kimi* model shows Kimi, glm* shows GLM). This fallback applies only when neither can be resolved — e.g. the harness runs in a terminal bb cannot see.",
      options: [
        "auto",
        "claude-code",
        "codex",
        "acp-cursor",
        "zai-glm",
        "kimi-coding",
      ],
      default: "auto",
    },
  });

  /** Last successful snapshot, so a failing refresh keeps showing numbers. */
  let cached = await bb.storage.kv.get<Snapshot>(SNAPSHOT_KEY);

  /** Fresh data, please: ordinary reads may reuse results for 10 s. */
  async function fetchLimits(
    providerId?: string,
  ): Promise<Record<string, RawProvider>> {
    return (await bb.sdk.system.usageLimits(
      providerId === undefined
        ? { refresh: true }
        : { providerId, refresh: true },
    )) as Record<string, RawProvider>;
  }

  /** One BB-managed provider: mapping + the transient-expired re-probe. */
  async function bbProviderUsage(
    descriptor: (typeof PROVIDERS)[number],
    entry: RawProvider,
    previous: ProviderUsage | undefined,
  ): Promise<ProviderUsage> {
    const { codexOfflineFallback } = await settings.get();

    // A provider that was ok a minute ago turning "expired" is usually a
    // stale-token race: the claude CLI refreshes its credentials on use,
    // bb only reads them passively. Re-probe that one provider before
    // believing the bad news.
    let effective = entry;
    const status = asString(entry.status);
    if (status !== null && status !== "ok" && status !== "not_installed") {
      if (previous?.status === "ok") {
        try {
          const retry = await fetchLimits(descriptor.providerId);
          const retryEntry =
            retry[descriptor.key] ?? retry[descriptor.providerId] ?? {};
          if (asString(retryEntry.status) === "ok") effective = retryEntry;
        } catch {
          // keep the fresh (bad) entry
        }
      }
    }

    const usage: ProviderUsage = {
      key: descriptor.key,
      providerId: descriptor.providerId,
      label: descriptor.label,
      status: asString(effective.status) ?? "error",
      message: asString(effective.message),
      accountEmail: asString(effective.accountEmail),
      planLabel: asString(effective.planLabel),
      windows: normalizeWindows(effective.windows),
      creditBalance: null,
      offlineSince: null,
    };

    if (
      descriptor.key === "codex" &&
      usage.status !== "ok" &&
      codexOfflineFallback
    ) {
      const disk = await readCodexSnapshot().catch(() => null);
      if (disk !== null) {
        usage.status = "ok";
        usage.planLabel = disk.planLabel;
        usage.windows = disk.windows.map((window) => ({
          ...window,
          cost: null,
        }));
        usage.creditBalance = disk.creditBalance;
        usage.offlineSince = disk.capturedAt;
      }
    }

    return usage;
  }

  function customProviderUsage(
    descriptor: (typeof CUSTOM_PROVIDERS)[number],
    custom: Awaited<ReturnType<typeof readZaiUsage>>,
  ): ProviderUsage {
    return {
      key: descriptor.providerId,
      providerId: descriptor.providerId,
      label: descriptor.label,
      status: custom.status,
      message: custom.message,
      accountEmail: null,
      planLabel: custom.planLabel,
      windows: custom.windows.map((window) => ({
        label: window.label,
        usedPercent: window.usedPercent,
        resetsAt: window.resetsAt,
        cost: null,
      })),
      creditBalance: null,
      offlineSince: null,
    };
  }

  async function collect(): Promise<Snapshot> {
    let raw: Record<string, RawProvider>;
    try {
      raw = await fetchLimits();
    } catch (error) {
      // Total failure: keep the previous providers visible and say why.
      const message = error instanceof Error ? error.message : String(error);
      return {
        providers: cached?.providers ?? [],
        fetchedAt: cached?.fetchedAt ?? null,
        error: message,
      };
    }

    const providers: ProviderUsage[] = [];
    for (const descriptor of PROVIDERS) {
      const entry = raw[descriptor.key] ?? raw[descriptor.providerId] ?? {};
      const previous = cached?.providers.find(
        (row) => row.key === descriptor.key,
      );
      providers.push(await bbProviderUsage(descriptor, entry, previous));
    }

    // Plans BB does not ship collectors for — our own direct fetches.
    for (const descriptor of CUSTOM_PROVIDERS) {
      const custom = await descriptor.collect(bb);
      if (custom.status === "not_installed") continue;
      providers.push(customProviderUsage(descriptor, custom));
    }

    return { providers, fetchedAt: new Date().toISOString(), error: null };
  }

  async function refresh(): Promise<Snapshot> {
    const snapshot = await collect();
    cached = snapshot;
    await bb.storage.kv.set(SNAPSHOT_KEY, snapshot);
    bb.realtime.publish(CHANNEL, { fetchedAt: snapshot.fetchedAt });
    return snapshot;
  }

  bb.rpc.register(rpcContract, {
    snapshot: () => cached ?? { providers: [], fetchedAt: null, error: null },
    refresh: () => refresh(),
    async refreshProvider({ providerId }) {
      // Refresh ONE provider and merge it into the cached snapshot — the
      // inline pill button refreshes just the harness the chat runs on.
      const snapshot = cached ?? { providers: [], fetchedAt: null, error: null };
      const previous = snapshot.providers.find(
        (row) => row.providerId === providerId,
      );

      let updated: ProviderUsage | null = null;
      const bbDescriptor = PROVIDERS.find(
        (descriptor) => descriptor.providerId === providerId,
      );
      if (bbDescriptor !== undefined) {
        try {
          const raw = await fetchLimits(providerId);
          updated = await bbProviderUsage(
            bbDescriptor,
            raw[bbDescriptor.key] ?? raw[providerId] ?? {},
            previous,
          );
        } catch (error) {
          bb.log.warn(`refreshProvider ${providerId}: ${String(error)}`);
        }
      } else {
        const custom = CUSTOM_PROVIDERS.find(
          (descriptor) => descriptor.providerId === providerId,
        );
        if (custom !== undefined) {
          const result = await custom.collect(bb);
          if (result.status !== "not_installed") {
            updated = customProviderUsage(custom, result);
          }
        }
      }

      if (updated !== null) {
        const order = [
          ...PROVIDERS.map((descriptor) => descriptor.providerId),
          ...CUSTOM_PROVIDERS.map((descriptor) => descriptor.providerId),
        ];
        const byId = new Map(
          snapshot.providers
            .filter((row) => row.providerId !== providerId)
            .map((row) => [row.providerId, row] as const),
        );
        byId.set(providerId, updated);
        cached = {
          providers: order
            .filter((id) => byId.has(id))
            .map((id) => byId.get(id)!),
          fetchedAt: new Date().toISOString(),
          error: snapshot.error ?? null,
        };
        await bb.storage.kv.set(SNAPSHOT_KEY, cached);
        bb.realtime.publish(CHANNEL, { fetchedAt: cached.fetchedAt });
      }
      return cached ?? { providers: [], fetchedAt: null, error: null };
    },
    async threadModel({ threadId }) {
      // Local daemon reads only — no provider traffic. The thread record
      // itself carries no model, but recent events do: `data.execution.model`
      // on the highest-seq event that has one is what the thread runs on.
      try {
        const events = (await bb.sdk.threads.events.list({
          threadId,
          limit: "50",
        })) as unknown as {
          seq?: unknown;
          data?: { execution?: { model?: unknown } };
        }[];
        const rows = Array.isArray(events) ? events : [];
        let best: { seq: number; model: string } | null = null;
        for (const row of rows) {
          const model = asString(row.data?.execution?.model);
          if (model === null) continue;
          const seq = typeof row.seq === "number" ? row.seq : 0;
          if (best === null || seq > best.seq) best = { seq, model };
        }
        return { model: best === null ? null : best.model, providerId: null };
      } catch {
        return { model: null, providerId: null };
      }
    },
  });

  bb.cli.register({
    name: "limits",
    summary: "Show remaining usage limits for each connected provider",
    commands: [
      { name: "show", summary: "Print current limits", usage: "bb limits" },
      {
        name: "refresh",
        summary: "Re-fetch limits before printing",
        usage: "bb limits refresh",
      },
    ],
    async run(argv) {
      const snapshot =
        argv[0] === "refresh"
          ? await refresh()
          : (cached ?? (await refresh()));

      const lines: string[] = [];
      for (const provider of snapshot.providers) {
        if (provider.status !== "ok") {
          lines.push(
            `${provider.label}: ${provider.message ?? provider.status}`,
          );
          continue;
        }
        const plan = provider.planLabel === null ? "" : ` (${provider.planLabel})`;
        lines.push(`${provider.label}${plan}`);
        for (const window of provider.windows) {
          const remaining = Math.max(0, 100 - window.usedPercent);
          const filled = Math.round((window.usedPercent / 100) * 20);
          const bar = "█".repeat(filled) + "░".repeat(20 - filled);
          const resets =
            window.resetsAt === null
              ? ""
              : `  resets ${new Date(window.resetsAt).toLocaleString()}`;
          lines.push(
            `  ${window.label.padEnd(18)} ${bar} ${remaining.toFixed(0)}% left${resets}`,
          );
        }
        if (provider.creditBalance !== null) {
          lines.push(`  credits: ${provider.creditBalance.toFixed(2)}`);
        }
        if (provider.offlineSince !== null) {
          lines.push(
            `  (from disk, captured ${new Date(provider.offlineSince).toLocaleString()})`,
          );
        }
      }
      if (snapshot.error !== null) lines.push(`error: ${snapshot.error}`);

      return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
    },
  });

  bb.background.service("refresh", {
    async start(signal) {
      while (!signal.aborted) {
        const { refreshSeconds } = await settings.get();
        const seconds = Number.parseInt(refreshSeconds, 10);

        // 0 = manual only: never fetch on our own — the only network calls
        // left are the user pressing Refresh in the header dialog (or
        // `bb limits refresh`). Keeps the machine off provider APIs unless
        // asked, for setups where unsolicited direct traffic is unwanted.
        if (seconds > 0) {
          // Race the refresh against abort: a hung provider fetch must not
          // wedge the service past its stop deadline.
          await Promise.race([
            refresh().catch((error) => {
              bb.log.warn(`refresh failed: ${String(error)}`);
            }),
            new Promise((resolve) =>
              signal.addEventListener("abort", resolve, { once: true }),
            ),
          ]);
        }

        // In manual mode just re-read settings occasionally; in auto mode
        // this is the refresh cadence.
        const delay = seconds > 0 ? seconds * 1000 : 60_000;
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, delay);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve(undefined);
            },
            { once: true },
          );
        });
      }
    },
  });
}
