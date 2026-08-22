# Performance measurements

Raw Lighthouse reports for the Day 3 optimisation pass, kept so the numbers in the
main README can be checked rather than taken on trust.

- `before.report.json` — Google Fonts loaded from the CDN, no compound index
- `after.report.json` — fonts self-hosted, `[grade+language]` index added

## Reproducing

```bash
npm run build && npm run preview
```

Then, against the running preview:

```bash
npx lighthouse http://localhost:4173/ --output=json --output-path=./perf/run --only-categories=performance --throttling.cpuSlowdownMultiplier=6 --chrome-flags="--headless=new"
```

`--throttling.cpuSlowdownMultiplier=6` is deliberate. Lighthouse's mobile preset
throttles at 4x by default; 6x is the closer approximation of the target device — a
2018-era Android with 2GB of RAM.

Measured against the local preview rather than the deployment, so the before/after
isolates code changes from network and CDN variance. Absolute numbers on the deployed
site will differ; the deltas are the point.

## Results

| metric | before | after |
|---|---|---|
| Performance score | 99 | 99 |
| First Contentful Paint | 1.7s | 1.5s |
| Speed Index | 1.7s | 1.5s |
| Largest Contentful Paint | 2.0s | 2.0s |
| Total Blocking Time | 0ms | 0ms |
| Time to Interactive | 2.0s | 2.0s |
| Main-thread work | 0.4s | 0.3s |
| Render-blocking requests | 3 | 2 |
| Third-party origins | 1 | 0 |

## What Lighthouse could not measure

Lighthouse audits a cold page load, so it says nothing about what the app does after
that. Three things here were measured directly in the browser instead, with
`performance.now()` over 30–60 iterations reporting medians:

**IndexedDB query** (`where({ grade, language })`, the app's hottest read):

| rows | before | after |
|---|---|---|
| 11 (a real student) | 0.5ms | 0.5ms |
| 3,011 (synthetic) | 12.5ms | 5.8ms |

The compound index earns nothing at real data sizes and 2.2x at scale. It is in the
schema because the query is O(rows) without it and because a schema that has never
been migrated has an untested migration path — not because it made this app faster.

**Navigation cost**, which drove a decision *not* to optimise:

| operation | median | max |
|---|---|---|
| full `#app` innerHTML rebuild | 1.1ms | 2.1ms |
| sidebar rebuild alone | 0.4ms | 12.6ms |
| toggling one class | 0.2ms |  |

The README used to claim the full-rebuild-per-navigation was "a visible stutter on a
Snapdragon 400". At 74 DOM nodes it is ~1.1ms, and even multiplied by 6 it stays well
inside a 16.7ms frame. Lighthouse agrees: 0ms Total Blocking Time. Rewriting the render
path to keep the sidebar mounted would have saved ~0.4ms and introduced staleness bugs,
so it was not done and the claim was removed.

**Handler binding.** One click on "Start Lesson" used to replace the app root twice, so
that measurement doubles as the fix: 2 replacements → 1.
