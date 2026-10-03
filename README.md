# Henge

A [Spicetify](https://spicetify.app/) extension that stacks Spotify's desktop layout
for tall screens. The main view spans the full width of the window. Your Library and
the right panel (Now Playing, Queue, Friend Activity) sit underneath it, side by side.

```
┌──────────────── global nav ────────────────┐
│                                            │
│            MAIN VIEW (full width)          │
│                                            │
╞════════════════ drag handle ═══════════════╡
│  LIBRARY        ║   RIGHT PANEL            │
├──────────────── now-playing bar ───────────┤
```

Drag the handles between panels to resize them.

> **Status: early development (v0.0.x).** The layout itself is not in yet.

## Install

1. Copy `henge.js` to `%APPDATA%\spicetify\Extensions\`
2. `spicetify config extensions henge.js`
3. `spicetify apply`

On Windows you can double-click `scripts\henge-on.cmd` instead. It does all three steps
from this folder.

## Turning it off

From quickest to most thorough:

| What | How | Restart needed? |
|---|---|---|
| Toggle the layout | **Ctrl+Alt+H** in Spotify | No |
| Keep it off between restarts | Ctrl+Alt+H remembers its last state | No |
| Unload the extension | Double-click `scripts\henge-off.cmd`, or `spicetify config extensions henge.js-` then `spicetify apply` | Yes |
| Reset Spicetify completely | `spicetify restore backup apply`, then `spicetify backup apply` | Yes |

Henge also checks itself every time it switches on. If the main view or the
now-playing bar ends up squashed or off screen, Henge turns itself off and shows a
notification.

## Compatibility

Henge is an extension, not a theme, so it works on top of your existing theme. It's
being tested with:

- Theme: Sleek (installed through Marketplace)
- Extensions: "Made For You" shortcut, Shuffle+, Collapsing Library, Beautiful Lyrics

Tested on Spotify 1.3.3 with Spicetify 2.45.3.

## Licence

MIT. See [LICENSE](LICENSE).
