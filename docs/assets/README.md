# wux brand assets

The wux mark is a small robot whose head is a tmux-style terminal: a tall top
pane with two green cursor "eyes", two lower panes each running a green `>_`
prompt, and a node-dot bridging them — a face and a multiplexer at once. It
follows the wux ethos: small, sharp, elegant, no clutter.

## Colors

| Role            | Hex       | Notes                                  |
| --------------- | --------- | -------------------------------------- |
| Ink (light bg)  | `#1A1A1A` | body, antennae, feet, wordmark         |
| Ink (dark bg)   | `#ECECEC` | inverted ink for the `-dark` variants  |
| Accent (green)  | `#3DDC84` | prompts, cursor eyes, node-dot         |

The mark uses exactly two colors. Interiors are open (no fill), so the panes
take on whatever background sits behind them.

## Files

| File                       | Use                                             |
| -------------------------- | ----------------------------------------------- |
| `wux-logo.svg`             | Full lockup (mark + wordmark) — primary, light bg |
| `wux-logo-dark.svg`        | Full lockup for dark backgrounds                |
| `wux-icon.svg`             | Head-only mark — favicon / app icon, light bg   |
| `wux-icon-dark.svg`        | Head-only mark for dark backgrounds             |
| `wux-logo-1200.png`        | Lockup raster, transparent (1200×1440)          |
| `wux-logo-1200-white.png`  | Lockup raster on white                          |
| `wux-logo-1200-dark.png`   | Lockup raster on `#1A1A1A`                       |
| `wux-icon-512.png`         | Icon raster, transparent                        |
| `wux-icon-512-dark.png`    | Icon raster (light ink), transparent            |
| `wux-icon-256.png`         | Icon raster, transparent                        |
| `apple-touch-icon-180.png` | iOS home-screen icon (white bg — iOS flattens)  |
| `favicon-48.png` / `-32` / `-16` | Browser favicons                          |

Prefer the **SVG** for anything that can consume it (infinitely scalable, ~2 KB).
PNGs are pre-rendered for contexts that need raster.

The README header swaps light/dark automatically via a `<picture>` element keyed
on `prefers-color-scheme`.

## Regenerating

The SVGs are hand-authored — edit them directly (two color strings, one
stroke-weight per group). To re-render the PNGs after an SVG change (requires
`rsvg-convert` / librsvg):

```bash
rsvg-convert -w 512  -h 512  wux-icon.svg      -o wux-icon-512.png
rsvg-convert -w 1200 -h 1440 wux-logo.svg      -o wux-logo-1200.png
# ...repeat per size; see git history for the full set
```

### Concept prompt

The design originated from this image-model brief (kept for provenance /
future iteration):

> Minimalist logo for a developer CLI called **"wux"** — a small, durable
> tmux-backed multiplexer for steering remote coding-agent sessions. A friendly
> robot whose head is a terminal split into three tmux-style panes: the top pane
> shows two green blinking-cursor "eyes", the two lower panes each show a green
> `>_` shell prompt, with a small connecting node-dot between the lower panes.
> Antennae and small feet. Below it, the monospace lowercase wordmark "wux".
> Flat vector, transparent background, exactly two colors — near-black `#1A1A1A`
> ink and a phosphor-green `#3DDC84` accent. Strong negative space, equal pane
> gutters, no gradients, no shadows, no 3D. Legible at 16 px favicon size.
