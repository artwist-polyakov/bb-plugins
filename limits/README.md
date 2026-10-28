# bb-plugin-limits

Remaining usage limits for each connected provider — as a floating chip row
in the app's top strip (visible on every surface, not just threads). Covers
Claude Code, Codex and Cursor through bb's own collectors, plus two plans bb
has no collectors for, fetched directly by this plugin:

- **GLM (Z.AI) Coding Plan**: `api.z.ai/api/monitor/usage/quota/limit`,
  token from `~/.config/zai/tokens.env` (`ZAI_TOKEN`, the zclaude setup);
  shows the Coding-plan window and the MCP-tools lane.
- **Kimi Code**: `api.kimi.com/coding/v1/usages`, access token from the
  kimi-code CLI credentials (`~/.kimi-code/credentials/kimi-code.json` or
  `$KIMI_CODE_CREDENTIALS`); shows the 7-day and 5-hour windows. Hidden until
  the credentials exist.

- **Top-strip overlay** (app-wide, via `experimental_appOverlay`): one chip
  per provider — a large brand mark, one small ring per limit window showing
  the remaining share (a full ring = everything left, shrinking and changing
  color green → amber → red as it runs out), then the scarcest window's
  remaining percent. The row sits left of bb's own header buttons, is
  click-through except for the chips, and hides on narrow windows.
  **Hover unfurls a detail card** (windows, bars, spend, credits);
  **right-click opens a dialog** with a Refresh button that re-fetches
  without closing. A provider that reports nothing gets a dashed ghost ring
  instead of silence.
- Which providers get a chip is set in plugin settings; Claude Code, Codex,
  Cursor, GLM (Z.AI) and Kimi Code are all on by default.
- Data comes from `system.usageLimits()` behind a cached background refresh
  (`refreshSeconds`), with a disk fallback for Codex.

## UI components

`components/ui/` is vendored source you own (the shadcn model): edit the
files freely — they never update out from under you. Add more from the BB
component registry (the full shadcn set, version-matched to your BB install
via the pinned ref in `components.json`):

```
npx shadcn add @bb/dialog @bb/select
```

Run `npm install` once before `bb plugin build` — the vendored components'
npm deps bundle into your dist. React, and BB-shimmed packages like the
radix portal primitives and `sonner` (`import { toast } from "sonner"`
reaches BB's own toaster), are provided by the BB app at runtime and never
bundled. Ship `dist/` (npm tarball or committed for git installs) so
people installing your plugin never need npm.

## Manifest

`package.json` is the plugin manifest. Notable fields:

- `bb.server` — backend entry (required); optional `bb.app` for a frontend.
- `bb.name` and `bb.description` — required human-facing identity.
- `bb.branding` — required; declare `icon` as a BB icon name or a
  plugin-relative compact SVG, or declare `logo.light` (with optional
  `logo.dark`). Logo assets must be relative `.svg`, `.png`, or
  `.webp` files.
- `engines.bb` — supported bb app version range.
- `engines.bbPluginSdk` — supported plugin SDK range (scaffold: `^0.4.1`).

Run `bb plugin build` before publishing git/npm installs. It writes
`dist/server.js` + `server.meta.json` (and, with `bb.app`, `app.js` /
`app.css` / `app.meta.json`). Each `*.meta.json` stamps SDK major/version,
`artifactFormatVersion`, `pluginId`, `pluginVersion`, and
`builtWith` so managed installs can verify the artifacts.

## Install

From this directory:

```
bb plugin install .
```

After editing sources, reload:

```
bb plugin reload limits
```

## Configure

```
bb plugin config limits
bb plugin config limits set showAcpCursor false
```

## Types & API reference

`types/bb-plugin-sdk.d.ts` (and `types/bb-plugin-sdk-app.d.ts` for the
frontend) are the full, bundled BB plugin API — `tsconfig.json` maps
`@bb/plugin-sdk` to them, so your editor and `tsc` see real types with no extra
install. Ask BB to write plugins for you: the `bb-plugin-authoring` skill
documents the whole surface with examples.

Confused by the API, or need something the types don't explain? Clone the BB
repo and read the source: <https://github.com/ymichael/bb>.
