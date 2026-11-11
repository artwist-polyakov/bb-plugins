// bb-plugin-limits — thread-header rings showing remaining provider quota.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  definePluginApp,
  experimental_useSidebarThreads,
  useBbContext,
  useRealtime,
  useRpc,
  useSettings,
} from "@bb/plugin-sdk/app";
import type { PluginRpcClient } from "@bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Contract = typeof rpcContract;

interface LimitWindow {
  label: string;
  usedPercent: number;
  resetsAt: string | null;
  cost: { usedUsdCents: number; limitUsdCents: number } | null;
}

interface Provider {
  key: string;
  providerId: string;
  label: string;
  status: string;
  message: string | null;
  accountEmail: string | null;
  planLabel: string | null;
  windows: LimitWindow[];
  creditBalance: number | null;
  offlineSince: string | null;
}

interface SnapshotData {
  providers: Provider[];
  fetchedAt: string | null;
  error: string | null;
}

/** Percent of the window still available — the number people actually want. */
function remaining(window: LimitWindow): number {
  return Math.max(0, Math.min(100, 100 - window.usedPercent));
}

/** Tightest window drives the summary line and the warning treatment. */
function scarcest(provider: Provider): LimitWindow | null {
  let tightest: LimitWindow | null = null;
  for (const window of provider.windows) {
    if (tightest === null || remaining(window) < remaining(tightest)) {
      tightest = window;
    }
  }
  return tightest;
}

/**
 * The window that drives the chip's number. Z.AI's other window is the
 * MCP-tools lane — when it runs out the agent keeps working, so the coding
 * plan is the one that actually matters there.
 */
function headline(provider: Provider): LimitWindow | null {
  return (
    provider.windows.find((window) => window.label === "Coding plan") ??
    scarcest(provider)
  );
}

function toneFor(left: number): string {
  if (left <= 10) return "text-destructive";
  if (left <= 25) return "text-amber-600 dark:text-amber-500";
  return "text-foreground";
}

function barFor(left: number): string {
  if (left <= 10) return "bg-destructive";
  if (left <= 25) return "bg-amber-600 dark:bg-amber-500";
  return "bg-foreground/70";
}

/** "in 4h", "in 3d" — a reset stamp is only useful as time-until. */
function untilLabel(iso: string | null): string | null {
  if (iso === null) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms)) return null;
  if (ms <= 0) return "resetting";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

function Meter({ left }: { left: number }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div
        className={`h-full rounded-full transition-[width] ${barFor(left)}`}
        style={{ width: `${left}%` }}
      />
    </div>
  );
}

/** Shared loader: the header chips and the dialog read the same cache. */
function useSnapshot(): {
  data: SnapshotData | null;
  isLoading: boolean;
  reload: (force?: boolean) => Promise<void>;
} {
  const rpc = useRpc<Contract>();
  const [data, setData] = useState<SnapshotData | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const reload = useCallback(
    (force = false) =>
      rpc
        .call(force ? "refresh" : "snapshot")
        .then((result) => {
          setData(result as SnapshotData);
        })
        .finally(() => setIsLoading(false)),
    [rpc],
  );

  useEffect(() => {
    void reload();
  }, [reload]);
  useRealtime("usage", () => void reload());

  return { data, isLoading, reload };
}

function statusNote(provider: Provider): string {
  switch (provider.status) {
    case "not_installed":
      return "not installed";
    case "unauthenticated":
      return "not signed in";
    case "expired":
      return "session expired";
    default:
      return provider.message ?? "unavailable";
  }
}

/**
 * Provider brand marks, traced from bb's own builtin provider icons.
 * Plain `currentColor` SVG paths — they inherit the surrounding tone.
 * Providers without a shipped logo fall back to a bold monogram letter.
 */
const BRANDS: Record<
  string,
  { viewBox: string; path: string; scale?: number } | { letter: string }
> = {
  "zai-glm": { letter: "Z" },
  "kimi-coding": { letter: "K" },
  // Claude's starburst fills its frame edge-to-edge; scale it down so it
  // keeps the same visual padding inside the ring as the other marks.
  "claude-code": {
    viewBox: "0 0 149 149",
    scale: 0.88,
    path: "M29.05 98.54L58.19 82.19L58.68 80.77L58.19 79.98H56.77L51.9 79.68L35.25 79.23L20.81 78.63L6.82 77.88L3.3 77.13L0 72.78L0.340004 70.61L3.3 68.62L7.54 68.99L16.91 69.63L30.97 70.6L41.17 71.2L56.28 72.77H58.68L59.02 71.8L58.2 71.2L57.56 70.6L43.01 60.74L27.26 50.32L19.01 44.32L14.55 41.28L12.3 38.43L11.33 32.21L15.38 27.75L20.82 28.12L22.21 28.49L27.72 32.73L39.49 41.84L54.86 53.16L57.11 55.03L58.01 54.39L58.12 53.94L57.11 52.25L48.75 37.14L39.83 21.77L35.86 15.4L34.81 11.58C34.44 10.01 34.17 8.69 34.17 7.08L38.78 0.820007L41.33 0L47.48 0.820007L50.07 3.07001L53.89 11.81L60.08 25.57L69.68 44.28L72.49 49.83L73.99 54.97L74.55 56.54H75.52V55.64L76.31 45.1L77.77 32.16L79.19 15.51L79.68 10.82L82 5.2L86.61 2.16L90.21 3.88L93.17 8.12L92.76 10.86L91 22.3L87.55 40.22L85.3 52.22H86.61L88.11 50.72L94.18 42.66L104.38 29.91L108.88 24.85L114.13 19.26L117.5 16.6H123.87L128.56 23.57L126.46 30.77L119.9 39.09L114.46 46.14L106.66 56.64L101.79 65.04L102.24 65.71L103.4 65.6L121.02 61.85L130.54 60.13L141.9 58.18L147.04 60.58L147.6 63.02L145.58 68.01L133.43 71.01L119.18 73.86L97.96 78.88L97.7 79.07L98 79.44L107.56 80.34L111.65 80.56H121.66L140.3 81.95L145.17 85.17L148.09 89.11L147.6 92.11L140.1 95.93L129.98 93.53L106.36 87.91L98.26 85.89H97.14V86.56L103.89 93.16L116.26 104.33L131.75 118.73L132.54 122.29L130.55 125.1L128.45 124.8L114.84 114.56L109.59 109.95L97.7 99.94H96.91V100.99L99.65 105L114.12 126.75L114.87 133.42L113.82 135.59L110.07 136.9L105.95 136.15L97.48 124.26L88.74 110.87L81.69 98.87L80.83 99.36L76.67 144.17L74.72 146.46L70.22 148.18L66.47 145.33L64.48 140.72L66.47 131.61L68.87 119.72L70.82 110.27L72.58 98.53L73.63 94.63L73.56 94.37L72.7 94.48L63.85 106.63L50.39 124.82L39.74 136.22L37.19 137.23L32.77 134.94L33.18 130.85L35.65 127.21L50.39 108.46L59.28 96.84L65.02 90.13L64.98 89.16H64.64L25.49 114.58L18.52 115.48L15.52 112.67L15.89 108.06L17.31 106.56L29.08 98.46L29.04 98.5L29.05 98.54Z",
  },
  codex: {
    viewBox: "0 0 24 24",
    path: "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.5045 4.5045 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.8956zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z",
  },
  "acp-cursor": {
    viewBox: "0 0 24 24",
    path: "M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23",
  },
};

function BrandMark({
  providerId,
  size,
  className,
}: {
  providerId: string;
  size: number;
  className?: string;
}) {
  const brand = BRANDS[providerId];
  if (brand === undefined) return null;

  if ("letter" in brand) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden="true"
        className={className}
      >
        <text
          x="12"
          y="13"
          textAnchor="middle"
          dominantBaseline="central"
          fontSize="17"
          fontWeight="700"
          fontFamily="inherit"
        >
          {brand.letter}
        </text>
      </svg>
    );
  }

  const scaled =
    brand.scale === undefined ? size : Math.round(size * brand.scale);
  return (
    <svg
      width={scaled}
      height={scaled}
      viewBox={brand.viewBox}
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path d={brand.path} />
    </svg>
  );
}

/** Compact per-window rows — shared by the hover card and the dialog. */
function WindowList({ provider }: { provider: Provider }) {
  return (
    <div className="space-y-2.5">
      {provider.windows.map((window) => {
        const left = remaining(window);
        const until = untilLabel(window.resetsAt);
        return (
          <div key={window.label} className="space-y-1">
            <div className="flex items-baseline justify-between gap-2 text-xs">
              <span className="text-muted-foreground">{window.label}</span>
              <span className={`tabular-nums ${toneFor(left)}`}>
                {left.toFixed(0)}% left
                {until === null ? null : (
                  <span className="ml-1.5 text-muted-foreground">{until}</span>
                )}
              </span>
            </div>
            <Meter left={left} />
            {window.cost === null ? null : (
              <p className="text-[11px] tabular-nums text-muted-foreground">
                ${(window.cost.usedUsdCents / 100).toFixed(2)} of $
                {(window.cost.limitUsdCents / 100).toFixed(2)}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Ring color for the remaining share. */
function ringTone(left: number): string {
  if (left <= 10) return "text-destructive";
  if (left <= 25) return "text-amber-500 dark:text-amber-400";
  return "text-emerald-500 dark:text-emerald-400";
}

/** One-word status for the chip's label when there is nothing to count. */
function shortStatus(provider: Provider): string {
  switch (provider.status) {
    case "not_installed":
      return "n/a";
    case "unauthenticated":
      return "sign in";
    case "expired":
      return "expired";
    default:
      return "err";
  }
}

/** A bare remaining-quota ring for one window — no logo inside, so it stays small. */
function ProgressRing({
  left,
  size,
  stroke,
  ghost = false,
}: {
  left: number;
  size: number;
  stroke: number;
  ghost?: boolean;
}) {
  const radius = (size - stroke) / 2 - 0.5;
  const circumference = 2 * Math.PI * radius;
  const center = size / 2;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className="-rotate-90 shrink-0"
      aria-hidden="true"
    >
      <circle
        cx={center}
        cy={center}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={stroke}
        strokeDasharray={ghost ? "2 2" : undefined}
        className={
          ghost ? "text-muted-foreground/50" : "text-muted-foreground/25"
        }
      />
      {ghost ? null : (
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - left / 100)}
          className={`transition-[stroke-dashoffset] ${ringTone(left)}`}
        />
      )}
    </svg>
  );
}

/**
 * Detail card that unfurls under the chip on hover: windows, bars, money,
 * credits. Pointer-transparent, so it never traps the cursor.
 */
function HoverCard({ provider }: { provider: Provider }) {
  const subtitle = [provider.planLabel, provider.accountEmail]
    .filter((part): part is string => part !== null)
    .join(" · ");

  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute bottom-full right-0 mb-1.5 block w-64 rounded-lg border bg-background p-3 text-left opacity-0 shadow-md transition-opacity delay-150 group-hover/chip:opacity-100 group-focus-within/chip:opacity-100"
    >
      <span className="mb-2 flex items-center gap-2">
        <BrandMark
          providerId={provider.providerId}
          size={16}
          className="shrink-0 text-foreground"
        />
        <span className="text-sm font-medium">{provider.label}</span>
        {subtitle === "" ? null : (
          <span className="ml-auto truncate text-xs text-muted-foreground">
            {subtitle}
          </span>
        )}
      </span>

      {provider.status !== "ok" ? (
        <span className="block text-xs text-muted-foreground">
          {statusNote(provider)}
        </span>
      ) : provider.windows.length === 0 ? (
        <span className="block text-xs text-muted-foreground">
          no limits reported
        </span>
      ) : (
        <WindowList provider={provider} />
      )}

      {provider.creditBalance === null ? null : (
        <span className="mt-2 block text-xs tabular-nums text-muted-foreground">
          Credits: {provider.creditBalance.toFixed(2)}
        </span>
      )}
      {provider.offlineSince === null ? null : (
        <span className="mt-1 block text-[11px] text-muted-foreground">
          from disk · captured {untilLabel(provider.offlineSince) ?? ""}
        </span>
      )}
    </span>
  );
}

/** One-shot click feedback: rings pulse and a radar ping expands. */
function useClickPulse() {
  const [pulsing, setPulsing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pulse = () => {
    setPulsing(false);
    requestAnimationFrame(() => setPulsing(true));
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setPulsing(false), 450);
  };
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  return { pulsing, pulse };
}

/**
 * One header block per provider: a large brand mark, one small ring per
 * limit window showing the remaining share (a full ring = everything left,
 * shrinking and changing color as it runs out), and the scarcest window's
 * remaining percent. Hover unfurls a detail card; right-click opens the
 * dialog with a Refresh button. A provider that reports nothing gets a
 * dashed ghost ring, not silence.
 */
function ProviderChip({
  providerId,
  label,
  setting,
  settingDefault,
  data,
  onOpen,
  suppressHover = false,
}: {
  providerId: string;
  label: string;
  setting: string;
  settingDefault: boolean;
  data: SnapshotData | null;
  onOpen: () => void;
  suppressHover?: boolean;
}) {
  const { values } = useSettings();
  const { pulsing, pulse } = useClickPulse();

  if ((values?.[setting] ?? settingDefault) === false) return null;

  const provider =
    data?.providers.find((entry) => entry.providerId === providerId) ?? null;
  if (data !== null && provider === null) return null;

  const healthy =
    provider !== null &&
    provider.status === "ok" &&
    provider.windows.some((window) => Number.isFinite(remaining(window)));
  const windows = healthy ? provider!.windows.slice(0, 3) : [];
  const tightest = healthy ? headline(provider!) : null;
  const left = tightest === null ? 0 : remaining(tightest);
  const text =
    provider === null ? "…" : healthy ? `${left.toFixed(0)}%` : shortStatus(provider);

  const logoSize = 30;
  const ringSize = 20;
  const stroke = 2.5;

  return (
    <span
      className="group/chip pointer-events-auto relative flex cursor-pointer items-center gap-2 [-webkit-app-region:no-drag]"
      role="img"
      aria-label={
        provider === null || !healthy
          ? `${label}: ${provider === null ? "loading" : statusNote(provider!)}`
          : `${label}: ${provider!.windows
              .map(
                (window) =>
                  `${window.label} ${remaining(window).toFixed(0)}% left`,
              )
              .join(" · ")}. Click for details & refresh`
      }
      onClick={() => {
        pulse();
        onOpen();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        onOpen();
      }}
    >
      <BrandMark
        providerId={providerId}
        size={logoSize}
        className={
          provider !== null && !healthy
            ? "shrink-0 text-muted-foreground/60"
            : "shrink-0 text-foreground"
        }
      />
      <span
        className={`relative flex items-center gap-1 ${
          pulsing ? "limits-ring-pulse" : ""
        }`}
      >
        {pulsing ? <span className="limits-ping" aria-hidden="true" /> : null}
        {windows.length > 0
          ? windows.map((window) => (
              <ProgressRing
                key={window.label}
                left={remaining(window)}
                size={ringSize}
                stroke={stroke}
              />
            ))
          : Array.from({ length: 2 }, (_, index) => (
              <ProgressRing
                key={index}
                left={0}
                size={ringSize}
                stroke={stroke}
                ghost
              />
            ))}
      </span>
      <span
        className={`tabular-nums text-xs leading-none ${
          healthy ? toneFor(left) : "text-muted-foreground"
        }`}
      >
        {text}
      </span>
      {provider === null || suppressHover ? null : (
        <HoverCard provider={provider} />
      )}
    </span>
  );
}

/** One provider's block in the details dialog. */
function ProviderRow({ provider }: { provider: Provider }) {
  const subtitle = [provider.planLabel, provider.accountEmail]
    .filter((part): part is string => part !== null)
    .join(" · ");

  return (
    <div className="space-y-2 rounded-lg border p-3">
      <div className="flex items-center gap-2">
        <BrandMark
          providerId={provider.providerId}
          size={16}
          className="shrink-0 text-foreground"
        />
        <span className="text-sm font-medium">{provider.label}</span>
        {subtitle === "" ? null : (
          <span className="ml-auto truncate text-xs text-muted-foreground">
            {subtitle}
          </span>
        )}
      </div>

      {provider.status !== "ok" ? (
        <p className="text-xs text-muted-foreground">{statusNote(provider)}</p>
      ) : provider.windows.length === 0 ? (
        <p className="text-xs text-muted-foreground">no limits reported</p>
      ) : (
        <WindowList provider={provider} />
      )}

      {provider.creditBalance === null ? null : (
        <p className="text-xs tabular-nums text-muted-foreground">
          Credits: {provider.creditBalance.toFixed(2)}
        </p>
      )}
      {provider.offlineSince === null ? null : (
        <p className="text-[11px] text-muted-foreground">
          from disk · captured {untilLabel(provider.offlineSince) ?? ""}
        </p>
      )}
    </div>
  );
}

/**
 * The details dialog (right-click on the chips): every provider, every
 * window, and a Refresh button that re-fetches without closing.
 */
function LimitsDialog({
  open,
  onOpenChange,
  data,
  reload,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: SnapshotData | null;
  reload: (force?: boolean) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const stamp = data?.fetchedAt ?? null;
  const updated = stamp === null ? null : new Date(stamp).toLocaleTimeString();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Limits</DialogTitle>
          <DialogDescription>
            {updated === null
              ? "Remaining quota per provider."
              : `Updated ${updated}`}
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 items-start gap-3">
          {(data?.providers ?? []).map((provider) => (
            <ProviderRow key={provider.key} provider={provider} />
          ))}
          {data?.error == null ? null : (
            <p className="text-xs text-destructive">{data.error}</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              reload(true)
                .catch(() => undefined)
                .finally(() => setBusy(false));
            }}
          >
            {busy ? "Refreshing…" : "Refresh"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Every provider, in display order — each renders as one chip in the
 * app-wide top-strip overlay.
 */
const PROVIDER_BLOCKS = [
  {
    providerId: "claude-code",
    setting: "showClaudeCode",
    default: true,
    label: "Claude Code",
  },
  { providerId: "codex", setting: "showCodex", default: true, label: "Codex" },
  {
    providerId: "acp-cursor",
    setting: "showAcpCursor",
    default: true,
    label: "Cursor",
  },
  {
    providerId: "zai-glm",
    setting: "showZaiGlm",
    default: true,
    label: "GLM (Z.AI)",
  },
  {
    providerId: "kimi-coding",
    setting: "showKimiCode",
    default: true,
    label: "Kimi Code",
  },
] as const;

/** Inline refresh: force-fetch ONE provider — the one the pill leads with. */
function RefreshLimitsButton({
  rpc,
  providerId,
  label,
  onRefreshed,
}: {
  rpc: PluginRpcClient<Contract>;
  providerId: string;
  label: string;
  onRefreshed: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      title={`Refresh ${label} limits`}
      aria-label={`Refresh ${label} limits`}
      disabled={busy}
      onClick={() => {
        setBusy(true);
        rpc
          .call("refreshProvider", { providerId })
          .then(() => onRefreshed())
          .catch(() => undefined)
          .finally(() => setBusy(false));
      }}
      className="ml-0.5 flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground disabled:cursor-default"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={busy ? "animate-spin" : undefined}
        aria-hidden="true"
      >
        <path d="M21 12a9 9 0 1 1-2.64-6.36" />
        <path d="M21 3v6h-6" />
      </svg>
    </button>
  );
}

/**
 * The floating pill, bottom-right: collapsed it shows only the scarcest
 * provider (the one that runs out first); hovering or focusing the pill
 * unfurls the rest. Visible on every surface — these are account-wide
 * limits, not any one thread's. Detail cards open upward, away from the
 * screen edge.
 */
function LimitsOverlay() {
  const { data, reload } = useSnapshot();
  const { values } = useSettings();
  const [dialogOpen, setDialogOpen] = useState(false);
  const { threadId } = useBbContext();
  const sidebar = experimental_useSidebarThreads();
  const rpc = useRpc<Contract>();
  const [threadModel, setThreadModel] = useState<{
    model: string | null;
  } | null>(null);
  // When a right split pane (browser, terminal, preview — sometimes a
  // native OS layer no z-index can beat) covers the pill's corner, the pill
  // moves to the chat pane's composer row, its right edge left of the
  // context-circle/send cluster. Panes are found by bb's own marker.
  const [rightPx, setRightPx] = useState<number | null>(null);

  // Free placement state lives above the measurement effect so the effect
  // can depend on it.
  const [pos, setPos] = useState<{ left: number; top: number } | null>(() => {
    try {
      const raw = localStorage.getItem("limits:pillPos");
      return raw === null
        ? null
        : (JSON.parse(raw) as { left: number; top: number });
    } catch {
      return null;
    }
  });
  const containerRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [repel, setRepel] = useState<{ left: number; top: number } | null>(
    null,
  );

  useEffect(() => {
    const PILL_WIDTH = 380;
    const PILL_HEIGHT = 48;
    const MARGIN = 12;
    const BOTTOM = 16;
    const RIGHT_CLUSTER = 180;

    const measure = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const pill = {
        left: w - MARGIN - PILL_WIDTH,
        right: w - MARGIN,
        top: h - BOTTOM - PILL_HEIGHT,
        bottom: h - BOTTOM,
      };
      const panes = Array.from(
        document.querySelectorAll("[data-split-pane-id]"),
      ).map((element) => element.getBoundingClientRect());
      // The browser pane (sometimes a native OS layer no z-index can beat)
      // sits right of the single split pane; its marker tells us it's there.
      const browserElement = document.querySelector("[data-app-browser]");
      if (browserElement === null) {
        setRightPx(null);
        return;
      }
      const browserRect = browserElement.getBoundingClientRect();
      const overlaps =
        browserRect.left < pill.right && browserRect.right > pill.left;
      if (!overlaps) {
        setRightPx(null);
        return;
      }
      // Park on the chat pane's composer row, left of the context-circle
      // cluster near that composer's right edge.
      const chat =
        panes.length > 0
          ? panes.reduce((a, rect) => (rect.left < a.left ? rect : a))
          : browserRect;
      const pillRightEdge = chat.right - RIGHT_CLUSTER;
      if (pillRightEdge - chat.left - MARGIN < PILL_WIDTH) {
        setRightPx(null);
        return;
      }
      const next = w - pillRightEdge;
      setRightPx((previous) => (previous === next ? previous : next));
    };

    // Custom placement: the browser pane repels the pill off its area —
    // shift left of the pane, or above it when there is no room. The user's
    // stored spot is untouched; the pill returns there once the pane closes.
    const measureRepel = () => {
      if (dragRef.current !== null) {
        setRepel(null);
        return;
      }
      const element = containerRef.current;
      if (element === null || pos === null) {
        setRepel(null);
        return;
      }
      const browserElement = document.querySelector("[data-app-browser]");
      if (browserElement === null) {
        setRepel(null);
        return;
      }
      const width = element.offsetWidth;
      const height = element.offsetHeight;
      const base = {
        left: pos.left,
        right: pos.left + width,
        top: pos.top,
        bottom: pos.top + height,
      };
      const rect = browserElement.getBoundingClientRect();
      const overlaps =
        rect.left < base.right &&
        rect.right > base.left &&
        rect.top < base.bottom &&
        rect.bottom > base.top;
      if (!overlaps) {
        setRepel(null);
        return;
      }
      const left = rect.left - MARGIN - width;
      if (left >= 8) {
        setRepel({ left, top: pos.top });
        return;
      }
      const top = rect.top - MARGIN - height;
      setRepel(top >= 40 ? { left: pos.left, top } : null);
    };

    measure();
    measureRepel();
    const timer = setInterval(() => {
      measure();
      measureRepel();
    }, 1000);
    window.addEventListener("resize", measureRepel);
    return () => {
      clearInterval(timer);
      window.removeEventListener("resize", measureRepel);
    };
  }, [pos]);

  // The thread's current model — a local daemon read (no provider traffic),
  // re-checked periodically so in-thread provider/model switches show up.
  useEffect(() => {
    if (threadId === null) {
      setThreadModel(null);
      return;
    }
    let alive = true;
    const load = () => {
      void rpc
        .call("threadModel", { threadId })
        .then((result) => {
          if (alive) setThreadModel(result as typeof threadModel);
        })
        .catch(() => undefined);
    };
    load();
    const timer = setInterval(load, 20_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [rpc, threadId]);

  const visible = PROVIDER_BLOCKS.filter(
    (block) => (values?.[block.setting] ?? block.default) !== false,
  );

  // Fallback order: whichever tracked plan runs out first.
  const byScarcest = [...visible].sort((a, b) => {
    const left = (block: (typeof PROVIDER_BLOCKS)[number]) => {
      const provider = data?.providers.find(
        (entry) => entry.providerId === block.providerId,
      );
      if (provider === undefined || provider.status !== "ok") return null;
      const tightest = headline(provider);
      return tightest === null ? null : remaining(tightest);
    };
    const aLeft = left(a);
    const bLeft = left(b);
    if (aLeft !== null && bLeft !== null) return aLeft - bLeft;
    if (aLeft !== null) return -1;
    if (bLeft !== null) return 1;
    return 0;
  });

  // The collapsed pill follows the OPEN THREAD: its provider when tracked,
  // else the plan its model runs on (a kimi* model shows Kimi, glm* — GLM;
  // those harnesses run through providers like pi). The pinned setting is a
  // fallback for when neither resolves, and the scarcest plan is the last
  // resort.
  const active =
    threadId === null
      ? undefined
      : sidebar.threads.find((thread) => thread.id === threadId);
  let resolved = visible.find(
    (block) => block.providerId === active?.providerId,
  );
  if (resolved === undefined && threadModel?.model != null) {
    const model = threadModel.model.toLowerCase();
    if (model.includes("kimi")) {
      resolved = visible.find((block) => block.providerId === "kimi-coding");
    } else if (model.includes("glm")) {
      resolved = visible.find((block) => block.providerId === "zai-glm");
    }
  }
  const pinned =
    typeof values?.collapsedProvider === "string" &&
    values.collapsedProvider !== "auto"
      ? visible.find((block) => block.providerId === values.collapsedProvider)
      : undefined;
  const primary = resolved ?? pinned ?? byScarcest[0];
  if (primary === undefined) return null;

  // Double-click collapses the pill to a single dot (and back). Kept in the
  // window's localStorage — no server round-trip for a purely visual pref.
  const [minimized, setMinimized] = useState(
    () => localStorage.getItem("limits:pillMinimized") === "1",
  );
  const toggleMinimized = () => {
    setMinimized((previous) => {
      localStorage.setItem("limits:pillMinimized", previous ? "0" : "1");
      return !previous;
    });
  };

  // Free placement: drag the plate anywhere; the spot is remembered per
  // window. Drop it back near the bottom-right corner to resume auto mode
  // (which also steps aside from browser panes). Declarations live above,
  // next to the measurement effect.
  const dragRef = useRef<{
    startX: number;
    startY: number;
    originLeft: number;
    originTop: number;
    moved: boolean;
  } | null>(null);
  const suppressClick = useRef(false);

  const onDragStart = (event: React.PointerEvent) => {
    if (dialogOpen) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect === undefined) return;
    dragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      originLeft: rect.left,
      originTop: rect.top,
      moved: false,
    };
  };
  const onDragMove = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (drag === null) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    if (!drag.moved) {
      drag.moved = true;
      setDragging(true);
      // Capture only once a real drag begins — capturing on pointer-down
      // would retarget the following click to the plate and silently kill
      // the refresh button and chip clicks.
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
    const width = containerRef.current?.offsetWidth ?? 380;
    const w = window.innerWidth;
    const h = window.innerHeight;
    setPos({
      left: Math.min(Math.max(drag.originLeft + dx, 8), w - 60),
      top: Math.min(Math.max(drag.originTop + dy, 40), h - 56),
    });
  };
  const onDragEnd = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag === null || !drag.moved) return;
    setDragging(false);
    suppressClick.current = true;
    requestAnimationFrame(() => {
      suppressClick.current = false;
    });
    setPos((current) => {
      if (current === null) return null;
      const w = window.innerWidth;
      const h = window.innerHeight;
      // Dropped back onto the default corner → auto mode again.
      if (current.left > w - 100 && current.top > h - 130) {
        localStorage.removeItem("limits:pillPos");
        return null;
      }
      localStorage.setItem("limits:pillPos", JSON.stringify(current));
      return current;
    });
  };
  const openDialog = () => {
    if (!suppressClick.current) setDialogOpen(true);
  };
  const dotPulse = useClickPulse();
  // Pulse the whole pill whenever fresh data lands — a visible "it really
  // refreshed" even when the numbers barely move.
  const dataPulse = useClickPulse();
  const dataStamp = data?.fetchedAt ?? null;
  useEffect(() => {
    if (dataStamp !== null) dataPulse.pulse();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataStamp]);

  const primaryProvider =
    data?.providers.find(
      (entry) => entry.providerId === primary.providerId,
    ) ?? null;
  const primaryHealthy =
    primaryProvider !== null &&
    primaryProvider.status === "ok" &&
    headline(primaryProvider) !== null;
  const primaryLeft = primaryHealthy
    ? remaining(headline(primaryProvider!)!)
    : 0;

  return (
    <div
      ref={containerRef}
      title="Limits · drag to place, drop in the corner for auto"
      className={`pointer-events-none fixed z-[60] hidden md:block ${
        dragging ? "" : "transition-all duration-200"
      } ${pos === null ? (minimized ? "right-3 bottom-14" : "right-3 bottom-4") : ""}`}
      style={
        repel !== null
          ? { left: `${repel.left}px`, top: `${repel.top}px` }
          : pos === null
            ? rightPx === null
              ? undefined
              : { right: `${rightPx}px` }
            : { left: `${pos.left}px`, top: `${pos.top}px` }
      }
    >
      {/* Click-feedback animations (inline: the built CSS has no keyframes slot). */}
      <style>{`
@keyframes limits-ring-pulse-kf {
  0% { transform: scale(1); }
  35% { transform: scale(1.18); filter: drop-shadow(0 0 6px currentColor); }
  100% { transform: scale(1); }
}
@keyframes limits-ping-kf {
  from { transform: scale(0.6); opacity: 0.55; }
  to { transform: scale(2.1); opacity: 0; }
}
.limits-ring-pulse { animation: limits-ring-pulse-kf 420ms ease-out; }
.limits-ping {
  position: absolute;
  inset: -4px;
  border-radius: 9999px;
  border: 2px solid currentColor;
  pointer-events: none;
  animation: limits-ping-kf 420ms ease-out forwards;
}
      `}</style>
      {minimized ? (
        <div className={`group/chip pointer-events-auto relative flex cursor-pointer touch-none select-none items-center rounded-full border border-border/60 bg-background/75 p-1.5 shadow-sm backdrop-blur-md [-webkit-app-region:no-drag] ${
          dragging ? "scale-110 cursor-grabbing shadow-lg" : ""
        } ${dotPulse.pulsing || dataPulse.pulsing ? "limits-ring-pulse" : ""}`}
          role="img"
          onPointerDown={onDragStart}
          onPointerMove={onDragMove}
          onPointerUp={onDragEnd}
          onPointerCancel={onDragEnd}
          aria-label={
            primaryProvider === null
              ? "Limits"
              : `${primary.label}: ${primaryHealthy ? `${primaryLeft.toFixed(0)}% left` : statusNote(primaryProvider)}`
          }
          onClick={() => {
            dotPulse.pulse();
            setTimeout(openDialog, 240);
          }}
        >
          <ProgressRing
            left={primaryHealthy ? primaryLeft : 0}
            size={18}
            stroke={2.5}
            ghost={!primaryHealthy}
          />
          {primaryProvider === null || dragging ? null : (
            <HoverCard provider={primaryProvider} />
          )}
        </div>
      ) : (
      <div
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
        className={`pointer-events-auto flex cursor-grab touch-none select-none items-center rounded-full border border-border/60 bg-background/75 py-1.5 pr-3.5 pl-2.5 shadow-sm backdrop-blur-md [-webkit-app-region:no-drag] ${
          dragging ? "scale-[1.03] cursor-grabbing shadow-lg" : ""
        } ${dialogOpen ? "pointer-events-none opacity-0" : "opacity-100"}`}
      >
        <ProviderChip
          providerId={primary.providerId}
          label={primary.label}
          setting={primary.setting}
          settingDefault={primary.default}
          data={data}
          onOpen={() => {
            // The chip pulses itself; the dialog opens after a beat so the
            // animation isn't hidden behind the dim layer.
            setTimeout(openDialog, 240);
          }}
          suppressHover={dragging}
        />
        <RefreshLimitsButton
          rpc={rpc}
          providerId={primary.providerId}
          label={primary.label}
          onRefreshed={() => void reload(false)}
        />
      </div>
      )}
      <button
        type="button"
        title={minimized ? "Expand limits pill" : "Minimize limits pill"}
        aria-label={minimized ? "Expand limits pill" : "Minimize limits pill"}
        onClick={(event) => {
          event.stopPropagation();
          toggleMinimized();
        }}
        className={`pointer-events-auto absolute -top-2.5 right-2 flex h-4 w-6 cursor-pointer items-center justify-center rounded-full border border-border/60 bg-background/80 text-muted-foreground shadow-sm backdrop-blur-md transition-colors hover:text-foreground [-webkit-app-region:no-drag] ${
          dialogOpen ? "hidden" : ""
        }`}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          {minimized ? (
            <path d="M6 10l6 6 6-6" />
          ) : (
            <path d="M6 14l6-6 6 6" />
          )}
        </svg>
      </button>
      {/* One shared dialog for the whole pill — per-chip instances stack
         into layers that look like a broken close button. */}
      <LimitsDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        data={data}
        reload={reload}
      />
    </div>
  );
}

/** The top strip only — the limits are app-wide and live nowhere else. */
export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({
    id: "limits-topbar",
    component: LimitsOverlay,
  });
});
