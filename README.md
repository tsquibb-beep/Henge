# Henge

A [Spicetify](https://spicetify.app/) extension that stacks Spotify's desktop layout
for tall screens. The main view spans the full width of the window. Two panels sit
underneath it, side by side, and you choose what goes where: your Library, Now
Playing, the Queue, Lyrics and more.

```
┌──────────────── global nav ────────────────┐
│                                            │
│            MAIN VIEW (full width)          │
│                                            │
╞════════════════ drag handle ═══════════════╡
│  LIBRARY        ║   NOW PLAYING / QUEUE    │
├──────────────── now-playing bar ───────────┤
```

Drag the handles between panels to resize them. Double-click a handle to reset it.

![Henge: the main view on top, pinned Now Playing and Queue below](docs/preview.png)

## Install

You need the Spotify desktop app with [Spicetify](https://spicetify.app/docs/getting-started)
already installed and working.

### From Spicetify Marketplace (easiest)

Open **Marketplace** in Spotify, search the **Extensions** tab for **Henge**, and click
**Install**. Use either Marketplace or the manual install below, not both. If both are
present, only one copy runs.

### Manually

1. Download `henge.js` from the [latest release](https://github.com/tsquibb-beep/Henge/releases/latest).
2. Put it in Spicetify's Extensions folder:
   - **Windows:** `%APPDATA%\spicetify\Extensions\`
   - **macOS / Linux:** `~/.config/spicetify/Extensions/`

   Not sure where it is? Run `spicetify path userdata`; the folder is `Extensions` inside it.
3. In a terminal, run:
   ```
   spicetify config extensions henge.js
   spicetify apply
   ```

Spotify restarts with the stacked layout. Press **Ctrl+Alt+H** at any time to switch
between Henge and Spotify's normal layout.

**Windows shortcut:** if you've cloned this repository, double-click
`scripts\henge-on.cmd`. It copies `henge.js` into place, registers it and applies.

**Updating:** Marketplace updates Henge for you. For a manual install, download the
new `henge.js` over the old one and run `spicetify apply`. Either way, your layout and
panel sizes are kept.

**Uninstalling:** from Marketplace, click **Remove** on Henge's card. For a manual
install, run `spicetify config extensions henge.js-`, then `spicetify apply`. On
Windows you can double-click `scripts\henge-off.cmd` instead.

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

Picking something that's already in another panel swaps the two. Your layout is
remembered between restarts. The map closes by itself a couple of seconds after your
mouse leaves it; you can also click elsewhere or press Escape.

The first time a pinned panel is shown in a session, Henge opens it in Spotify's side
panel (or, for Lyrics, the main view) for a moment to borrow it, then puts things back
as they were.

## Turning it off

From quickest to most thorough:

| What | How | Restart needed? |
|---|---|---|
| Toggle the layout | **Ctrl+Alt+H** in Spotify (it remembers the last state) | No |
| Unload the extension | `spicetify config extensions henge.js-` then `spicetify apply` (or `scripts\henge-off.cmd`) | Yes |
| Reset Spicetify completely | `spicetify restore backup apply`, then `spicetify backup apply` | Yes |

Henge checks itself every time it switches on. If the main view or the now-playing bar
ends up squashed or off screen, Henge turns itself off and shows a notification. If a
layout change would do the same, Henge puts the previous layout back.

## Compatibility

Henge is an extension, not a theme, so it works on top of your existing theme.

- **Tested on:** Spotify 1.3.3 with Spicetify 2.45.3, on Windows.
- **Works alongside:** the Sleek theme, and the "Made For You" shortcut, Shuffle+ and
  Collapsing Library extensions.
- **Themes:** most themes work. Themes that rearrange Spotify's layout themselves may
  not look right with Henge. Press Ctrl+Alt+H to compare.
- **Not supported:** Spotify's Cinema modes (expanded Now Playing and lyrics cinema).
  They assume Spotify's own three-column layout, so they look broken while Henge is on.
  Press Ctrl+Alt+H to switch Henge off if you want to use them.

Henge works by rearranging Spotify's own interface, so a Spotify update can break it.
If that happens, press Ctrl+Alt+H to get Spotify's normal layout back and
[open an issue](https://github.com/tsquibb-beep/Henge/issues). The **Copy diagnostics**
link in the Henge layout map copies a report that helps.

## Licence

MIT. See [LICENSE](LICENSE).
