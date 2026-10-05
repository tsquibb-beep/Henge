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

Drag the handles between panels to resize them. Double-click a handle to reset it.

> **Status: early development (v0.x).**

## Choosing what each panel shows

Click the **Henge layout** button in the top bar. It shows a small map of the three
panels (top, bottom left, bottom right), each with a dropdown:

- **Main view:** the page you're browsing. It always has to be somewhere.
- **Library**
- **Side panel:** Spotify's Now Playing, Queue or Friend Activity, whichever is open.
- **Pinned panels:** Now Playing, Queue, Friend Activity or Lyrics, each shown on its
  own. These are live copies of Spotify's own panels, with the same menus, drag and drop
  and updates, so you can have Now Playing and the Queue side by side, or lyrics
  alongside a playlist.
- **Nothing:** the neighbouring panel takes the space.

The first time a pinned panel is shown in a session, Henge opens it in Spotify's side
panel (or, for Lyrics, the main view) for a moment to borrow it, then puts things back
as they were.

The map closes by itself a couple of seconds after your mouse leaves it. You can
also click elsewhere or press Escape. Picking something that's already in another
panel swaps the two. Your layout is
remembered between restarts. If a choice would leave the main view or the now-playing
bar squashed or off screen, Henge puts the previous layout back.

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

**Not supported:** Spotify's Cinema modes (expanded Now Playing and lyrics cinema).
They assume Spotify's own three-column layout, so they look broken while Henge is on.
Press Ctrl+Alt+H to switch Henge off if you want to use them.

## Licence

MIT. See [LICENSE](LICENSE).
