# m4max bb plugins

Personal bb plugins, published to the bb Community marketplace. One repo,
independent per-plugin releases (`<plugin>/vX.Y.Z` tags).

| Plugin | What it does |
| --- | --- |
| [limits](limits/) | Floating usage-limit rings for coding plans (Claude, Codex, Cursor, GLM, Kimi) |

## Development

```
cd limits
npm install
npx tsc --noEmit     # types
bb plugin build .    # build dist
```

Changes go through PRs: branch, commit, push, review, merge, tag.
