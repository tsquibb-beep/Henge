// Spicetify Extension: Henge — stacked Spotify layout
// ─────────────────────────────────────────────────────
// Main view spans the full width; two panels sit below it, side by side.
// The Layout button in the top bar picks what each of the three slots shows.
// Drag the handles between panels to resize; double-click a handle to reset.
//
// Off switch: Ctrl+Alt+H toggles the layout instantly (no restart).
// Emergency:  scripts\henge-off.cmd unloads the extension entirely.
//
// Installation:
//   1. Copy to %APPDATA%\spicetify\Extensions\
//   2. spicetify config extensions henge.js
//   3. spicetify apply

(async () => {
    // Keep in sync with version.txt (the single source of truth). version.txt
    // can't be read at runtime — there's no build step — so it's mirrored here.
    const VERSION = '1.1.0';

    // One copy only. Installed both from Marketplace and in Spicetify's
    // Extensions folder, two copies would load; claim the slot before the
    // first await so the second sees it.
    if (window.__hengeLoaded) {
        console.warn(`[Henge] v${VERSION} not started: v${window.__hengeLoaded} is already running (installed twice?)`);
        return;
    }
    window.__hengeLoaded = VERSION;

    const LS_ENABLED = 'henge:enabled';
    const LS_LAYOUT  = 'henge:layout';         // JSON {top, left, right}
    const LS_BOTTOM  = 'henge:bottomHeight';   // px, bottom row height
    // px, left column width. The key predates slots (it was the library's
    // width when the library always sat on the left); kept so the saved size
    // carries over.
    const LS_COLUMN  = 'henge:libraryWidth';

    const ROOT_CLASS = 'henge-on';
    const STYLE_ID   = 'henge-style';          // static rules
    const LAYOUT_ID  = 'henge-layout';         // rules generated from the layout
    const UI_ID      = 'henge-ui-style';       // picker; present even when off
    const ROOT_SEL   = '.Root__top-container';
    const LEFT_ID    = 'Desktop_LeftSidebar_Id';

    // Size limits (px) the handles clamp to.
    const MIN_TOP    = 200;
    const MIN_BOTTOM = 150;
    const MIN_COLUMN = 200;
    // Spotify's collapsed (icon-strip) library is ~72px wide; anything at or
    // under this is treated as collapsed and left to Spotify to size.
    const COLLAPSED_MAX = 120;

    const html = document.documentElement;
    const log  = (...a) => console.log('[Henge]', ...a);
    const warn = (...a) => console.warn('[Henge]', ...a);
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    while (!Spicetify?.showNotification || !Spicetify?.Topbar?.Button || !document.querySelector(ROOT_SEL)) {
        await sleep(100);
    }

    // ── Slots and sources ─────────────────────────────────────────────────────
    // Three slots, named after the grid areas they use. The area names stay
    // Spotify's own because Spotify's overlays (lyrics cinema and four hashed
    // "Q44…" layers) span those named lines; removing a name would create
    // implicit grid tracks and push the layout around.

    const SLOTS = ['top', 'left', 'right'];
    const AREA  = { top: 'main-view', left: 'left-sidebar', right: 'right-sidebar' };
    const SLOT_LABEL = { top: 'Top', left: 'Bottom left', right: 'Bottom right' };

    // Grid items (from Henge.recon() on 1.3.3): #Desktop_LeftSidebar_Id,
    // #main-view, the side panel (the child holding #Desktop_PanelContainer_Id),
    // the now-playing bar, #global-nav-bar, plus overlays that span named lines.
    // The library's previous sibling is a placeholder Spotify shows only in
    // expanded-library mode (it holds the library's column open).
    const RIGHT       = '.Root__top-container > :has(#Desktop_PanelContainer_Id)';
    const NO_RIGHT    = '.Root__top-container:not(:has(#Desktop_PanelContainer_Id))';
    const PLACEHOLDER = `.Root__top-container > :has(+ #${LEFT_ID})`;

    // `sel` matches the grid item; `child` is the same item as a selector that
    // can follow "NO_RIGHT >" (the side panel has none: it's the one missing).
    // Pinned panels are live second copies of Spotify's own side-panel views
    // (see "Pinned panels"); `control` is the Spotify button that opens one.
    const view = kind => `#henge-view-${kind}`;
    const SOURCES = {
        main:       { label: 'Main view',       group: 'Spotify', sel: '#main-view',  child: '#main-view' },
        library:    { label: 'Library',         group: 'Spotify', sel: `#${LEFT_ID}`, child: `#${LEFT_ID}` },
        panel:      { label: 'Side panel',      group: 'Spotify', sel: RIGHT,         child: null },
        nowplaying: { label: 'Now Playing',     group: 'Pinned panels', sel: view('nowplaying'), child: view('nowplaying'), pinned: true, control: 'Now Playing' },
        queue:      { label: 'Queue',           group: 'Pinned panels', sel: view('queue'),      child: view('queue'),      pinned: true, control: 'Queue' },
        friends:    { label: 'Friend Activity', group: 'Pinned panels', sel: view('friends'),    child: view('friends'),    pinned: true, control: 'Friend Activity' },
        // Spotify's lyrics are a main-view page, not a side panel: captured
        // from the main view instead (see openAndCaptureMain).
        lyrics:     { label: 'Lyrics',          group: 'Pinned panels', sel: view('lyrics'),     child: view('lyrics'),     pinned: true, from: 'main', route: '/lyrics' },
        // Drawn by Henge itself (`own`), not captured: see "Visualiser".
        visualiser: { label: 'Visualiser',      group: 'Henge',         sel: view('visualiser'), child: view('visualiser'), pinned: true, own: true },
        none:      { label: 'Nothing',         group: null },
    };

    const DEFAULT_LAYOUT = { top: 'main', left: 'library', right: 'panel' };

    // Valid = every slot holds a known source, nothing but "none" repeats, and
    // the main view is placed (it's where navigation lands).
    function validLayout(l) {
        if (!l || typeof l !== 'object') return false;
        const used = SLOTS.map(s => l[s]);
        if (!used.every(src => src in SOURCES)) return false;
        const real = used.filter(src => src !== 'none');
        return new Set(real).size === real.length && real.includes('main');
    }

    function readLayout() {
        try {
            const l = JSON.parse(lsGet(LS_LAYOUT));
            if (validLayout(l)) return { top: l.top, left: l.left, right: l.right };
        } catch {}
        return { ...DEFAULT_LAYOUT };
    }

    let layout = readLayout();

    const slotOf = (l, src) => SLOTS.find(s => l[s] === src) ?? null;
    const sibling = slot => (slot === 'left' ? 'right' : slot === 'right' ? 'left' : null);

    // Picking a source that's already in another slot swaps the two slots.
    function withSource(l, slot, src) {
        const next = { ...l };
        const from = src === 'none' ? null : slotOf(l, src);
        if (from && from !== slot) next[from] = l[slot];
        next[slot] = src;
        return next;
    }

    // ── Static CSS ────────────────────────────────────────────────────────────
    // Every rule is scoped under html.henge-on, so removing that one class
    // restores Spotify's native layout.
    //
    // State classes on <html>, kept current by updateState():
    //   henge-lib-collapsed — library is Spotify's icon strip
    //   henge-lib-expanded  — "Expand Your Library" mode
    //   henge-resizing      — a Henge handle is being dragged

    const CSS = `
html.henge-on .Root__top-container {
    grid-template-areas:
        "top-banner top-banner"
        "global-nav global-nav"
        "main-view main-view"
        "left-sidebar right-sidebar"
        "now-playing-bar now-playing-bar" !important;
    grid-template-rows: auto auto minmax(0, 1fr) var(--henge-bottom-h, 40%) auto !important;
    grid-template-columns: var(--henge-left-w, 40%) minmax(0, 1fr) !important;
}

/* ── Every source fills its slot ── */

html.henge-on #main-view,
html.henge-on ${RIGHT} {
    width: auto !important;
    min-width: 0 !important;
}
/* The library's width is Spotify's only when collapsed to the icon strip. */
html.henge-on:not(.henge-lib-collapsed) #${LEFT_ID} {
    width: auto !important;
    min-width: 0 !important;
}
/* Spotify's library resizer is replaced by Henge's handles, except when
   collapsed, where dragging it out is how you expand. */
html.henge-on:not(.henge-lib-collapsed) #${LEFT_ID} > .LayoutResizer__resize-bar {
    display: none !important;
}
/* The expanded-mode placeholder would hold an empty column open. Taken out of
   flow rather than display:none, because updateState() reads its display. */
html.henge-on ${PLACEHOLDER} {
    position: absolute !important;
    visibility: hidden !important;
    pointer-events: none !important;
}

/* Side panel: four wrappers sit between the grid item and the <aside>; one
   carries an inline width from React (the panel's native size) and the rest
   shrink to it. Stretch every element on that chain, whatever its class. */
html.henge-on ${RIGHT} :has(#Desktop_PanelContainer_Id) {
    flex: 1 1 auto !important;
    width: 100% !important;
    min-width: 0 !important;
    max-width: none !important;
}
html.henge-on #Desktop_PanelContainer_Id {
    flex: 1 1 auto !important;
    width: 100% !important;
    max-width: none !important;
}
/* Its own resizer: Henge's handles do that job now. */
html.henge-on ${RIGHT} > .LayoutResizer__resize-bar {
    display: none !important;
}

/* ── Overlays ── */

/* Lyrics cinema natively spans from the library's right edge to the window's.
   Stacked, that becomes the whole area above the bottom row. */
html.henge-on .Root__lyrics-cinema {
    grid-area: 1 / 1 / left-sidebar-start / -1 !important;
}

/* ── "Side panel is closed" placeholder (only shown by layout rules) ── */

#henge-panel-placeholder {
    display: none;
}
html.henge-on #henge-panel-placeholder {
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    border-radius: 8px;
    background-color: var(--background-base, #121212);
    color: var(--text-subdued, #b3b3b3);
    font-size: 14px;
}
/* ── Pinned panels ── */

html.henge-on .henge-view {
    display: flex;
    flex-direction: column;
    position: relative;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    border-radius: 8px;
    background-color: var(--background-base, #121212);
}
/* Carries the captured <aside>'s own classes, so Spotify styles the copy
   exactly like the original panel. Pinned to the view's box so its size is
   definite: Spotify's panels size their scroll areas with height: 100%,
   which a flex-sized box didn't resolve, so Now Playing's scroll area grew
   past the view and its end was clipped (field feedback 2026-10-04). */
html.henge-on .henge-view-content {
    position: absolute !important;
    inset: 0;
    width: auto !important;
    height: auto !important;
}
/* Side-panel views size themselves against the panel slot Spotify wraps them
   in (.Gl1s… { container: panel-slot/size }), e.g. Now Playing's height:
   100cqh. Without a size container above it, cqh falls back to the window
   height and the view runs off the bottom of its slot. */
html.henge-on #henge-view-nowplaying > .henge-view-content,
html.henge-on #henge-view-queue > .henge-view-content,
html.henge-on #henge-view-friends > .henge-view-content {
    container: panel-slot / size;
}
/* A main-view page (lyrics) normally scrolls in the main view's scroll node;
   in its own slot it scrolls here. */
html.henge-on #henge-view-lyrics .henge-view-content {
    overflow-y: auto;
}
/* The lyrics "back to current line" button fades in and out on a CSS view
   timeline that the current line publishes; #main-view declares its scope,
   so the view has to as well. Name from Spotify's CSS (1.3.3). */
html.henge-on #henge-view-lyrics {
    timeline-scope: --scroll-to-viewport-button-anim;
}
/* Instead of lyrics, Spotify may show a message (none for this song,
   couldn't load, ad) or a spinner, centred in the page box. That box is
   sized to the window (height: calc(100vh - 73px)), so in a shorter view the
   message sat below the bottom edge. While one shows, size the page to the
   view instead. The message's text is sized for the window width too; scale
   it to the view's. Spotify's hashed classes change between versions, so each
   list holds the 1.3.6 class, then the 1.3.3 one (message, message text,
   spinner). */
html.henge-on #henge-view-lyrics .henge-view-content :has(.XJwa_tmi0vV5R8tuyhvS, .FeJPf6Jbrnf5iLPPmIAx, .lzSRPoTbAKaWG_T2CDlK, .fPIOq6k3nkToIHbUnayO) {
    height: 100% !important;
}
html.henge-on #henge-view-lyrics :is(.XJwa_tmi0vV5R8tuyhvS, .lzSRPoTbAKaWG_T2CDlK) {
    container-type: inline-size;
}
html.henge-on #henge-view-lyrics :is(.nqoWPf1ClF5kduiIPoYH, .bfuVjuVXkeriMvFjcZMD) {
    margin-inline: 8cqi;
    font-size: clamp(1.5rem, 5.5cqi, 4.5rem);
    line-height: 1.2;
}
/* Holds that button: centred, just above the bottom of the view. */
html.henge-on .henge-view-after {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 0;
    z-index: 1;
    display: flex;
    justify-content: center;
}
.henge-view-msg {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    height: 100%;
    padding: 16px;
    color: var(--text-subdued, #b3b3b3);
    font-size: 14px;
    text-align: center;
}
/* The visualiser's canvases (the wave, then grain and flashes) fill the
   view; its messages sit over them. */
html.henge-on #henge-view-visualiser canvas {
    position: absolute;
    inset: 0;
    display: block;
    width: 100%;
    height: 100%;
}
html.henge-on #henge-view-visualiser .henge-view-msg {
    position: absolute;
    inset: 0;
    height: auto;
}
html.henge-on #henge-view-visualiser .henge-view-msg[hidden] {
    display: none;
}
#henge-panel-placeholder .henge-ph-buttons {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 8px;
}
#henge-panel-placeholder button,
.henge-view-msg button {
    padding: 6px 14px;
    border: 1px solid var(--essential-subdued, #727272);
    border-radius: 999px;
    background: none;
    color: var(--text-base, #fff);
    font: inherit;
    cursor: pointer;
}
#henge-panel-placeholder button:hover,
.henge-view-msg button:hover {
    border-color: var(--text-base, #fff);
}

/* ── Henge handles (styled after Spotify's LayoutResizer) ── */

.henge-handle {
    display: none;
}
html.henge-on .henge-handle {
    display: flex;
    position: relative;
    z-index: var(--above-everything-except-now-playing-bar-z-index, 5);
    align-items: center;
    justify-content: center;
    opacity: 0;
    touch-action: none;
    transition: opacity .15s ease-out;
}
html.henge-on .henge-handle:hover,
html.henge-on .henge-handle.henge-dragging {
    opacity: 1;
}
html.henge-on .henge-handle::after {
    content: "";
    border-radius: 1px;
    background-color: var(--essential-subdued, #7c7c7c);
    transition: background-color .15s ease-out;
}
html.henge-on .henge-handle.henge-dragging::after {
    background-color: var(--essential-base, #fff);
}

/* Between the top slot and the bottom row, in the panel gap. */
html.henge-on #henge-row-handle {
    grid-row: left-sidebar;
    grid-column: 1 / -1;
    align-self: start;
    height: var(--panel-gap);
    margin-top: calc(-1 * var(--panel-gap));
    cursor: row-resize;
}
html.henge-on #henge-row-handle::after {
    width: calc(100% - 16px);
    height: 1px;
}

/* Between the two bottom slots, in the panel gap. */
html.henge-on #henge-col-handle {
    grid-row: left-sidebar;
    grid-column: 2;
    justify-self: start;
    width: var(--panel-gap);
    margin-left: calc(-1 * var(--panel-gap));
    cursor: col-resize;
}
html.henge-on #henge-col-handle::after {
    width: 1px;
    height: calc(100% - 16px);
}

/* While dragging: no text selection, no hover flicker, steady cursor. */
html.henge-on.henge-resizing,
html.henge-on.henge-resizing * {
    user-select: none !important;
}
html.henge-on.henge-resizing #main {
    pointer-events: none;
}
html.henge-on.henge-resizing .henge-handle {
    pointer-events: auto;
}
`;

    // ── Layout CSS (generated) ────────────────────────────────────────────────
    // Places each source in its slot and handles the cases where a slot is
    // empty: "none" (known now) or a closed side panel (known only at runtime,
    // hence the :has()-based NO_RIGHT rules).

    function buildLayoutCSS(l) {
        const H = 'html.henge-on';
        const rules = [];
        const add = (sel, body) => rules.push(`${sel} { ${body} }`);
        const FULL_ROW = 'grid-column: 1 / -1 !important;';
        const BOTH_ROWS = 'grid-row: main-view-start / left-sidebar-end !important;';

        // Place, or hide, each source. Hidden Spotify sources stay mounted;
        // pinned panels only exist while placed, so need no hiding.
        for (const [src, def] of Object.entries(SOURCES)) {
            if (src === 'none') continue;
            const slot = slotOf(l, src);
            if (slot) add(`${H} ${def.sel}`, `grid-area: ${AREA[slot]} !important;`);
            else if (!def.pinned) add(`${H} ${def.sel}`, 'display: none !important;');
        }

        // A bottom slot that's empty lets its neighbour take the whole row.
        for (const slot of ['left', 'right']) {
            const src = l[slot], sib = sibling(slot), sibSrc = l[sib];
            if (sibSrc === 'none') continue;
            if (src === 'none') {
                add(`${H} ${SOURCES[sibSrc].sel}`, FULL_ROW);
            } else if (src === 'panel' && SOURCES[sibSrc].child) {
                // The panel closes at runtime. A collapsed library stays an
                // icon strip rather than stretching across the row.
                const guard = sibSrc === 'library' ? ':not(.henge-lib-collapsed)' : '';
                add(`${H}${guard} ${NO_RIGHT} > ${SOURCES[sibSrc].child}`, FULL_ROW);
            }
        }

        // Empty top: the bottom slots take its height too. Empty bottom row:
        // the top slot takes the bottom row's height.
        if (l.top === 'none') {
            for (const slot of ['left', 'right']) {
                if (l[slot] !== 'none') add(`${H} ${SOURCES[l[slot]].sel}`, BOTH_ROWS);
            }
            add(`${H} #henge-row-handle`, 'display: none;');
        }
        if (l.left === 'none' && l.right === 'none') {
            add(`${H} ${SOURCES[l.top].sel}`, BOTH_ROWS);
            add(`${H} #henge-row-handle`, 'display: none;');
        }

        // Side panel in the top slot but closed: offer to open it.
        if (l.top === 'panel') {
            add(`${H} ${NO_RIGHT} > #henge-panel-placeholder`, 'display: flex; grid-area: main-view;');
        }

        // Library in a bottom slot: its collapsed and expanded modes.
        const libSlot = slotOf(l, 'library');
        if (libSlot === 'left' || libSlot === 'right') {
            // Collapsed: that column shrinks to the icon strip.
            add(`${H}.henge-lib-collapsed .Root__top-container`, libSlot === 'left'
                ? 'grid-template-columns: auto minmax(0, 1fr) !important;'
                : 'grid-template-columns: minmax(0, 1fr) auto !important;');
            add(`${H}.henge-lib-collapsed #henge-col-handle`, 'display: none;');
            // Expanded: it takes the whole bottom row; its neighbour is hidden
            // (not unmounted) so it comes back as it was.
            add(`${H}.henge-lib-expanded #${LEFT_ID}`, FULL_ROW);
            const sibSrc = l[sibling(libSlot)];
            if (sibSrc !== 'none') add(`${H}.henge-lib-expanded ${SOURCES[sibSrc].sel}`, 'visibility: hidden !important;');
            add(`${H}.henge-lib-expanded #henge-col-handle`, 'display: none;');
        }

        // Column handle: only when both bottom slots show something.
        if (l.left === 'none' || l.right === 'none') {
            add(`${H} #henge-col-handle`, 'display: none;');
        } else if (l.left === 'panel' || l.right === 'panel') {
            add(`${H} ${NO_RIGHT} > #henge-col-handle`, 'display: none;');
        }

        return rules.join('\n');
    }

    // ── Picker CSS (always present, so the button works when Henge is off) ──

    const UI_CSS = `
/* Spicetify gives top bar buttons the history buttons' class, which sizes
   icons for 16px; Henge's is drawn at 24px like the custom-app icons. */
.spicetify-topbar-button button[aria-label="Henge layout"] svg {
    width: 24px;
    height: 24px;
}
#henge-picker {
    position: fixed;
    z-index: 9999;
    width: 320px;
    padding: 14px;
    border-radius: 8px;
    background-color: var(--background-elevated-base, #282828);
    color: var(--text-base, #fff);
    box-shadow: 0 16px 24px rgba(0, 0, 0, .3), 0 6px 8px rgba(0, 0, 0, .2);
    font-size: 14px;
}
#henge-picker h2 {
    margin: 0 0 10px;
    font-size: 14px;
    font-weight: 700;
}
#henge-picker .henge-off-note {
    margin: 0 0 10px;
    color: var(--text-subdued, #b3b3b3);
    font-size: 13px;
}
#henge-picker .henge-map {
    display: grid;
    grid-template-columns: 1fr 1fr;
    grid-template-rows: 88px 72px;
    gap: 6px;
}
#henge-picker .henge-slot {
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 6px;
    padding: 8px;
    border: 1px solid var(--essential-subdued, #727272);
    border-radius: 6px;
}
#henge-picker .henge-slot--top {
    grid-column: 1 / -1;
}
#henge-picker .henge-slot span {
    color: var(--text-subdued, #b3b3b3);
    font-size: 11px;
    letter-spacing: .05em;
    text-transform: uppercase;
}
#henge-picker select {
    width: 100%;
    padding: 4px 6px;
    border: 0;
    border-radius: 4px;
    background-color: var(--background-elevated-highlight, #3e3e3e);
    color: inherit;
    font: inherit;
}
#henge-picker .henge-picker-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 8px;
}
#henge-picker .henge-picker-row span {
    flex: none;
    width: 6.5rem;
    color: var(--text-subdued, #b3b3b3);
    font-size: 11px;
    letter-spacing: .05em;
    text-transform: uppercase;
}
#henge-picker .henge-picker-foot {
    display: flex;
    justify-content: space-between;
    margin-top: 10px;
    color: var(--text-subdued, #b3b3b3);
    font-size: 12px;
}
#henge-picker .henge-picker-foot button {
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    text-decoration: underline;
    cursor: pointer;
}
`;

    // ── Storage ───────────────────────────────────────────────────────────────

    function lsGet(key) {
        try { return localStorage.getItem(key); } catch { return null; }
    }

    function lsSet(key, value) {
        try {
            if (value == null) localStorage.removeItem(key);
            else localStorage.setItem(key, String(value));
        } catch {}
    }

    function lsNumber(key) {
        const n = parseFloat(lsGet(key));
        return Number.isFinite(n) && n > 0 ? n : null;
    }

    const readEnabled  = () => lsGet(LS_ENABLED) !== '0';
    const writeEnabled = on => lsSet(LS_ENABLED, on ? '1' : '0');

    function notify(msg, isError = false) {
        try { Spicetify.showNotification(msg, isError, 3000); } catch {}
    }

    // ── Measuring ─────────────────────────────────────────────────────────────

    const getRoot = () => document.querySelector(ROOT_SEL);
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));

    // Computed grid tracks in px, e.g. "20px 20px 1100px 700px 72px".
    function tracks(prop) {
        const root = getRoot();
        if (!root) return [];
        return getComputedStyle(root)[prop]
            .replace(/\[[^\]]*\]/g, ' ')
            .trim().split(/\s+/).map(parseFloat);
    }

    // Top + bottom rows together: the height the row handle shares out.
    function stackHeight() {
        const rows = tracks('gridTemplateRows');
        return rows.length >= 5 ? rows[2] + rows[3] : null;
    }

    // Both columns together: the width the column handle shares out.
    function rowWidth() {
        const cols = tracks('gridTemplateColumns');
        return cols.length >= 2 ? cols[0] + cols[1] : null;
    }

    // ── Sizes ─────────────────────────────────────────────────────────────────
    // The saved sizes are preferences; what's applied is clamped to the window,
    // so shrinking the window and growing it back restores the preference.

    function setVar(name, value) {
        const root = getRoot();
        if (!root) return;
        if (value == null) root.style.removeProperty(name);
        else root.style.setProperty(name, `${Math.round(value)}px`);
    }

    function applyBottom(pref = lsNumber(LS_BOTTOM)) {
        if (pref == null) return setVar('--henge-bottom-h', null);
        const total = stackHeight();
        setVar('--henge-bottom-h', total ? clamp(pref, MIN_BOTTOM, total - MIN_TOP) : pref);
    }

    function applyColumn(pref = lsNumber(LS_COLUMN)) {
        if (pref == null) return setVar('--henge-left-w', null);
        const total = rowWidth();
        setVar('--henge-left-w', total ? clamp(pref, MIN_COLUMN, total - MIN_COLUMN) : pref);
    }

    function applySizes() {
        applyBottom();
        applyColumn();
    }

    // ── State classes ─────────────────────────────────────────────────────────

    function updateState() {
        const left = document.getElementById(LEFT_ID);
        let collapsed = false, expanded = false;
        if (left) {
            const native = parseFloat(getComputedStyle(left).getPropertyValue('--left-sidebar-width'));
            collapsed = Number.isFinite(native) && native > 0 && native <= COLLAPSED_MAX;
            const placeholder = left.previousElementSibling;
            expanded = !!placeholder && getComputedStyle(placeholder).display !== 'none';
        }
        html.classList.toggle('henge-lib-collapsed', collapsed);
        html.classList.toggle('henge-lib-expanded', expanded);
    }

    // ── Handles ───────────────────────────────────────────────────────────────

    function makeHandle(id, label, { start, move, reset }) {
        const el = document.createElement('div');
        el.id = id;
        el.className = 'henge-handle';
        el.setAttribute('role', 'separator');
        el.setAttribute('aria-label', label);
        el.title = `${label} — double-click to reset`;

        el.addEventListener('pointerdown', e => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            const ctx = start(e);
            if (!ctx) return;
            el.setPointerCapture(e.pointerId);
            el.classList.add('henge-dragging');
            html.classList.add('henge-resizing');

            const onMove = ev => move(ctx, ev);
            const onUp = () => {
                el.removeEventListener('pointermove', onMove);
                el.removeEventListener('pointerup', onUp);
                el.removeEventListener('pointercancel', onUp);
                el.classList.remove('henge-dragging');
                html.classList.remove('henge-resizing');
                ctx.save?.();
            };
            el.addEventListener('pointermove', onMove);
            el.addEventListener('pointerup', onUp);
            el.addEventListener('pointercancel', onUp);
        });

        el.addEventListener('dblclick', e => {
            e.preventDefault();
            reset();
        });

        return el;
    }

    const rowHandle = makeHandle('henge-row-handle', 'Resize top and bottom panels', {
        start(e) {
            const rows = tracks('gridTemplateRows');
            if (rows.length < 5) return null;
            const ctx = { y: e.clientY, bottom: rows[3], total: rows[2] + rows[3], value: rows[3] };
            ctx.save = () => lsSet(LS_BOTTOM, Math.round(ctx.value));
            return ctx;
        },
        move(ctx, e) {
            ctx.value = clamp(ctx.bottom - (e.clientY - ctx.y), MIN_BOTTOM, ctx.total - MIN_TOP);
            setVar('--henge-bottom-h', ctx.value);
        },
        reset() {
            lsSet(LS_BOTTOM, null);
            applyBottom();
        },
    });

    const colHandle = makeHandle('henge-col-handle', 'Resize bottom panels', {
        start(e) {
            const cols = tracks('gridTemplateColumns');
            if (cols.length < 2) return null;
            const ctx = { x: e.clientX, left: cols[0], total: cols[0] + cols[1], value: cols[0] };
            ctx.save = () => lsSet(LS_COLUMN, Math.round(ctx.value));
            return ctx;
        },
        move(ctx, e) {
            ctx.value = clamp(ctx.left + (e.clientX - ctx.x), MIN_COLUMN, ctx.total - MIN_COLUMN);
            setVar('--henge-left-w', ctx.value);
        },
        reset() {
            lsSet(LS_COLUMN, null);
            applyColumn();
        },
    });

    // ── Side panel placeholder ────────────────────────────────────────────────
    // Shown in the top slot when the side panel is assigned there but closed.
    // Its buttons click Spotify's own controls. Selectors confirmed by
    // Henge.probe() on 1.3.3: the NPV button has no test id, and Friend
    // Activity is labelled "Listening activity" in the global nav.

    const PANEL_CONTROLS = {
        'Now Playing': ['[data-testid="control-button-npv"]', 'button[aria-label="Now playing view"]'],
        'Queue': ['[data-testid="control-button-queue"]', 'button[aria-label="Queue"]'],
        'Friend Activity': ['button[aria-label="Listening activity"]', 'button[aria-label="Friend Activity"]'],
    };

    function clickControl(name) {
        for (const sel of PANEL_CONTROLS[name]) {
            const el = document.querySelector(sel);
            if (el) { el.click(); return true; }
        }
        notify(`Couldn't find Spotify's ${name} button`, true);
        return false;
    }

    const panelPlaceholder = (() => {
        const el = document.createElement('div');
        el.id = 'henge-panel-placeholder';
        el.append('The side panel is closed');
        const buttons = document.createElement('div');
        buttons.className = 'henge-ph-buttons';
        for (const name of Object.keys(PANEL_CONTROLS)) {
            const b = document.createElement('button');
            b.textContent = name;
            b.addEventListener('click', () => clickControl(name));
            buttons.append(b);
        }
        el.append(buttons);
        return el;
    })();

    function ensureExtras(root) {
        for (const el of [rowHandle, colHandle, panelPlaceholder, ...[...views.values()].map(v => v.el)]) {
            if (el.parentElement !== root) root.appendChild(el);
        }
    }

    // ── React internals ───────────────────────────────────────────────────────
    // Spotify's React tree, read through the fibres React hangs off DOM nodes.
    // Generic on purpose (no hashed names), so Spotify updates are less likely
    // to break it. Spotify runs React 18.3.1.

    const COMPOSITE_TAGS = new Set([0, 1, 11, 14, 15]); // function, class, forwardRef, memo, simple memo
    const PROVIDER_TAG = 10;
    const HOST_ROOT_TAG = 3;
    const ASIDE_ID = 'Desktop_PanelContainer_Id';

    function fiberOf(el) {
        const key = el && Object.keys(el).find(k => k.startsWith('__reactFiber$'));
        return key ? el[key] : null;
    }

    function fiberName(f) {
        const t = f.elementType ?? f.type;
        return t?.displayName || t?.name || t?.render?.displayName || t?.render?.name
            || t?.type?.displayName || t?.type?.name || `(anonymous, tag ${f.tag})`;
    }

    // A DOM node's fibre can be the stale half of React's current/alternate
    // pair. Walk up to the root, then back down the *current* tree along the
    // same path. Returns current fibres leaf-first, or null if the path is no
    // longer mounted.
    function currentPath(fiber) {
        const chain = [];
        for (let f = fiber; f; f = f.return) chain.push(f);
        const top = chain[chain.length - 1];
        if (!top || top.tag !== HOST_ROOT_TAG || !top.stateNode?.current) return null;
        let cur = top.stateNode.current;
        const out = [cur];
        for (let i = chain.length - 2; i >= 0; i--) {
            const target = chain[i];
            let c = cur.child;
            while (c && c !== target && c.alternate !== target) c = c.sibling;
            if (!c) return null;
            out.push(c);
            cur = c;
        }
        return out.reverse();
    }

    // Component fibres under a fibre, depth-first, outermost first.
    function componentsUnder(fiber, limit = 12, maxDepth = 8) {
        const out = [];
        const stack = [[fiber.child, 0]];
        while (stack.length && out.length < limit) {
            const [f, depth] = stack.pop();
            if (!f) continue;
            if (COMPOSITE_TAGS.has(f.tag)) out.push({ fiber: f, depth });
            if (f.sibling) stack.push([f.sibling, depth]);
            if (f.child && depth < maxDepth) stack.push([f.child, depth + 1]);
        }
        return out;
    }

    // Context providers from a fibre up to the root, innermost first.
    function providersAbove(fiber) {
        const list = [];
        for (let f = fiber; f; f = f.return) {
            if (f.tag === PROVIDER_TAG) list.push({ fiber: f, type: f.type, value: f.memoizedProps?.value });
        }
        return list;
    }

    // Spicetify.ReactDOM is the module with createPortal; createRoot may live
    // in react-dom/client. Look in webpack's cache of already-loaded modules
    // only, so nothing new gets executed.
    let createRootFn;
    function getCreateRoot() {
        if (createRootFn !== undefined) return createRootFn;
        createRootFn = null;
        if (typeof Spicetify.ReactDOM?.createRoot === 'function') return (createRootFn = Spicetify.ReactDOM.createRoot);
        let req = null;
        try { window.webpackChunkclient_web.push([[Symbol('henge')], {}, r => { req = r; }]); } catch {}
        for (const mod of Object.values(req?.c ?? {})) {
            const ex = mod?.exports;
            if (ex && typeof ex.createRoot === 'function' && typeof ex.hydrateRoot === 'function') {
                return (createRootFn = ex.createRoot);
            }
        }
        return createRootFn;
    }

    // ── Pinned panels ─────────────────────────────────────────────────────────
    // A pinned panel is a live second copy of one of Spotify's side-panel views
    // (Now Playing, Queue, Friend Activity), rendered by Henge into its own grid
    // item with Spotify's own component. Proven by the Henge.spike() experiment
    // on 2026-10-04: menus, playback, drag and live updates all work.
    //
    // Capture: while the real side panel shows the view, take the outermost
    // component under its <aside> (element + props) and every context provider
    // above it. If it isn't showing, Henge clicks Spotify's button to open it,
    // captures, and puts the side panel back. Captures last for the session.
    //
    // Context values: app-wide providers (those above #main-view too) are
    // re-read from the live tree every couple of seconds so the copy never
    // goes stale. Panel-local providers keep their captured values on purpose:
    // they're what tell a pinned Queue that it is the Queue.

    const LS_PANEL_LABELS = 'henge:panelLabels'; // aside aria-label → kind, learned
    const captured = {};                          // kind → capture
    const views = new Map();                      // kind → { el, content, root, values, error, attempt }

    const panelLabels = (() => {
        try { return JSON.parse(lsGet(LS_PANEL_LABELS)) ?? {}; } catch { return {}; }
    })();

    function learnLabel(label, kind) {
        if (!label || panelLabels[label] === kind) return;
        panelLabels[label] = kind;
        lsSet(LS_PANEL_LABELS, JSON.stringify(panelLabels));
    }

    const panelAsides = () => document.querySelectorAll(`#${ASIDE_ID}`);
    // The side panel's <aside>, once any open/close animation has finished
    // (during one, two can be mounted).
    const settledAside = () => { const a = panelAsides(); return a.length === 1 ? a[0] : null; };

    function asideComponents(aside, limit = 8) {
        const fiber = fiberOf(aside);
        if (!fiber) return [];
        const path = currentPath(fiber);
        return componentsUnder(path ? path[0] : fiber, limit);
    }

    // Identifies what the side panel is showing, to notice when it changes.
    function panelSignature(aside) {
        return `${aside.getAttribute('aria-label') ?? ''}|${asideComponents(aside).map(c => fiberName(c.fiber)).join(',')}`;
    }

    // Which pinned kind the side panel is showing: learned labels first, then
    // what's recognisable without having learned anything.
    function kindOfAside(aside) {
        const label = aside.getAttribute('aria-label') ?? '';
        if (panelLabels[label]) return panelLabels[label];
        if (asideComponents(aside).some(c => /NowPlayingView/.test(fiberName(c.fiber)))) return 'nowplaying';
        if (/^queue$/i.test(label)) return 'queue';
        if (/friend|listening activity/i.test(label)) return 'friends';
        return null;
    }

    function captureAside(aside) {
        const top = asideComponents(aside, 1)[0];
        if (!top) throw new Error('the side panel has no component yet');
        return {
            element: Spicetify.React.createElement(top.fiber.elementType ?? top.fiber.type, { ...top.fiber.memoizedProps }),
            providers: providersAbove(top.fiber.return),
            asideClass: aside.className,
            label: aside.getAttribute('aria-label'),
        };
    }

    async function waitFor(pred, timeout = 2500, step = 50) {
        const end = Date.now() + timeout;
        while (Date.now() < end) {
            let v = null;
            try { v = pred(); } catch {}
            if (v) return v;
            await sleep(step);
        }
        return null;
    }

    // ── Capturing a main-view page (lyrics) ──
    // Proven by Henge.spike(11, 'main') on 2026-10-04: the component directly
    // under the page wrapper (the fibre with a `pageId` prop) takes no props,
    // follows the playing track, highlights, scrolls and seeks on its own.

    const spotifyHistory = () => Spicetify.Platform?.History;
    const onRoute = route => spotifyHistory()?.location?.pathname === route;

    // The page's own component: first component under the page wrapper.
    function mainPageComponent() {
        const fiber = fiberOf(document.getElementById('main-view'));
        if (!fiber) return null;
        const top = currentPath(fiber)?.[0] ?? fiber;
        const page = componentsUnder(top, 200, 60).find(c => 'pageId' in (c.fiber.memoizedProps ?? {}));
        return page ? componentsUnder(page.fiber, 1)[0]?.fiber ?? null : null;
    }

    // Show the page in the main view (if it isn't already), capture it, go
    // back to where the main view was.
    async function openAndCaptureMain(kind) {
        const { route, label } = SOURCES[kind];
        const H = spotifyHistory();
        if (!H) throw new Error("Spotify's navigation isn't available");
        const navigated = !onRoute(route);
        if (navigated) H.push(route);
        try {
            const found = await waitFor(() => onRoute(route) && mainPageComponent(), 4000);
            if (!found) throw new Error(`the ${label} page didn't open`);
            await sleep(300); // let the page settle
            const page = mainPageComponent() ?? found;
            const providers = providersAbove(page.return);
            captured[kind] = {
                element: Spicetify.React.createElement(page.elementType ?? page.type, { ...page.memoizedProps }),
                providers,
                asideClass: '',
                label,
                ownScrollNode: true, // see scrollNodeFor
            };
        } finally {
            if (navigated && onRoute(route)) (H.goBack ?? H.back)?.call(H);
        }
    }

    // Open `kind` in the real side panel (if needed), capture it, put the
    // side panel back the way it was.
    async function openAndCapture(kind) {
        if (SOURCES[kind].from === 'main') return openAndCaptureMain(kind);
        const control = SOURCES[kind].control;
        const before = settledAside();
        const wasOpen = !!document.getElementById(ASIDE_ID);
        const beforeKind = before ? kindOfAside(before) : null;

        if (before && beforeKind === kind) {
            captured[kind] = captureAside(before);
            learnLabel(captured[kind].label, kind);
            return;
        }

        const beforeSig = before ? panelSignature(before) : null;
        if (!clickControl(control)) throw new Error(`Spotify's ${control} button wasn't found`);

        // Either the wanted view appears, or the panel shuts: Spotify's buttons
        // toggle, so that means it was already showing (unrecognised).
        const opened = () => {
            const a = settledAside();
            if (a) return panelSignature(a) !== beforeSig ? a : null;
            return wasOpen && !document.getElementById(ASIDE_ID) ? 'closed' : null;
        };
        let after = await waitFor(opened);
        let wasThisKind = false;
        if (after === 'closed') {
            await sleep(300); // a switch can pass through "no panel"; make sure
            after = settledAside() ?? 'closed';
            if (after === 'closed') {
                wasThisKind = true;
                clickControl(control);
                after = await waitFor(settledAside);
            }
        }
        if (!after || after === 'closed') throw new Error(`${SOURCES[kind].label} didn't open`);

        await sleep(300); // let the panel settle
        const cap = captureAside(settledAside() ?? after);
        captured[kind] = cap;
        learnLabel(cap.label, kind);

        // Put the side panel back.
        if (!wasOpen) clickControl(control);
        else if (!wasThisKind && beforeKind && beforeKind !== kind) clickControl(SOURCES[beforeKind].control);
    }

    // One capture at a time: each one drives the real side panel.
    let captureChain = Promise.resolve();
    const capturing = new Map();

    function ensureCaptured(kind) {
        if (captured[kind]) return Promise.resolve();
        if (capturing.has(kind)) return capturing.get(kind);
        const p = captureChain
            .then(() => (captured[kind] ? null : openAndCapture(kind)))
            .finally(() => capturing.delete(kind));
        captureChain = p.catch(() => {});
        capturing.set(kind, p);
        return p;
    }

    // Context values for a capture: app-wide providers re-read live.
    function freshValues(cap) {
        const live = new Map();
        for (const f of currentPath(fiberOf(document.getElementById('main-view'))) ?? []) {
            if (f.tag !== PROVIDER_TAG) continue;
            live.set(f, f.memoizedProps?.value);
            if (f.alternate) live.set(f.alternate, f.memoizedProps?.value);
        }
        return cap.providers.map(p => (live.has(p.fiber) ? live.get(p.fiber) : p.value));
    }

    // A main-view page measures itself against Spotify's ScrollNodeContext
    // ({ scrollNodeRef, scrollNodeChildRef, afterTheScrollNodeRef,
    // beforeTheScrollNodeRef }), i.e. the main view's scroll area. Lyrics only
    // auto-scroll while the current line sits in a "comfort zone" of that
    // node's rect (xpui-modules.js, the lyrics line component), so a copy
    // placed anywhere but over the main view never scrolls. Point the copy at
    // its own scroll area instead. The object is cached per source value so
    // React sees a stable context while nothing changes.
    function scrollNodeFor(cap, v, value) {
        if (!cap.ownScrollNode || !value || typeof value !== 'object' || !('scrollNodeRef' in value)) return value;
        if (v.scrollCtx?.src !== value) {
            const content = v.content;
            v.scrollCtx = {
                src: value,
                ctx: {
                    ...value,
                    scrollNodeRef: { current: content },
                    scrollNodeChildRef: { get current() { return content.firstElementChild; } },
                    // Things Spotify portals around the scroll area (e.g. the
                    // lyrics "back to current line" button) land in the view.
                    beforeTheScrollNodeRef: { current: v.before },
                    afterTheScrollNodeRef: { current: v.after },
                },
            };
        }
        return v.scrollCtx.ctx;
    }

    // Spotify's lyrics pause auto-scroll while a scroll is "in progress": a
    // scroll listener sets the flag and only a `scrollend` clears it (module
    // 75160 and the lyrics line component). A scroll the browser makes on its
    // own, e.g. clamping when the next song's lyrics are shorter, may never
    // fire `scrollend`, leaving auto-scroll stuck off. Back-stop: once
    // scrolling has been idle a moment, send one (what Spotify itself does in
    // browsers without `onscrollend`).
    function watchScrollEnd(el) {
        let timer = null;
        el.addEventListener('scroll', () => {
            clearTimeout(timer);
            timer = setTimeout(() => el.dispatchEvent(new Event('scrollend')), 450);
        }, { passive: true });
    }

    // Short description of a context value, for Henge.recon().
    const valueKeys = v => (v && typeof v === 'object' ? Object.keys(v).slice(0, 8).join(',') : typeof v);

    let ViewBoundary = null;
    function viewBoundary() {
        if (ViewBoundary) return ViewBoundary;
        const R = Spicetify.React;
        ViewBoundary = class HengeViewBoundary extends R.Component {
            constructor(props) { super(props); this.state = { error: null }; }
            static getDerivedStateFromError(error) { return { error }; }
            componentDidCatch(error) { warn(`${this.props.label} crashed:`, error); }
            render() {
                if (!this.state.error) return this.props.children;
                return viewMessage(`${this.props.label} stopped working.`, this.props.onRetry);
            }
        };
        return ViewBoundary;
    }

    function viewMessage(text, onRetry) {
        const R = Spicetify.React;
        return R.createElement('div', { className: 'henge-view-msg' },
            text,
            onRetry ? R.createElement('button', { onClick: onRetry }, 'Retry') : null);
    }

    function renderView(kind) {
        const v = views.get(kind);
        if (!v) return;
        const R = Spicetify.React;
        const label = SOURCES[kind].label;
        const createRoot = getCreateRoot();
        if (!createRoot) {
            v.content.textContent = `Henge can't show ${label}: React's createRoot wasn't found.`;
            return;
        }
        v.root ??= createRoot(v.content);
        const cap = captured[kind];
        if (!cap) {
            v.content.className = 'henge-view-content';
            v.values = null;
            v.root.render(v.error
                ? viewMessage(`Couldn't load ${label}: ${v.error}`, () => loadView(kind, true))
                : viewMessage(`Loading ${label}…`));
            return;
        }
        v.content.className = `henge-view-content ${cap.asideClass}`;
        v.values = freshValues(cap);
        let el = cap.element;
        cap.providers.forEach((p, i) => {
            el = R.createElement(p.type, { value: scrollNodeFor(cap, v, v.values[i]) }, el);
        });
        v.root.render(R.createElement(viewBoundary(), { key: v.attempt, label, onRetry: () => loadView(kind, true) }, el));
    }

    // (Re)capture if needed, then render. retry=true drops the old capture.
    function loadView(kind, retry = false) {
        const v = views.get(kind);
        if (!v) return;
        if (retry) { delete captured[kind]; v.attempt++; }
        v.error = null;
        renderView(kind);
        ensureCaptured(kind).then(
            () => renderView(kind),
            e => { warn(`couldn't capture ${kind}:`, e); if (views.get(kind) === v) { v.error = e.message; renderView(kind); } });
    }

    function mountView(kind) {
        const el = document.createElement('div');
        el.id = `henge-view-${kind}`;
        el.className = 'henge-view';
        const content = document.createElement('div');
        content.className = 'henge-view-content';
        // A main-view page scrolls in the view itself, with slots before and
        // after the scroll area like the main view has (see scrollNodeFor).
        const ownScroll = SOURCES[kind].from === 'main';
        const before = ownScroll ? document.createElement('div') : null;
        const after = ownScroll ? document.createElement('div') : null;
        if (after) after.className = 'henge-view-after';
        el.append(...[before, content, after].filter(Boolean));
        if (ownScroll) watchScrollEnd(content);
        views.set(kind, { el, content, before, after, root: null, values: null, error: null, attempt: 0 });
        getRoot()?.appendChild(el);
        if (SOURCES[kind].own) visualiser.mount(content);
        else loadView(kind);
    }

    // A new song's lyrics start at the top, as they do in the main view.
    Spicetify.Player?.addEventListener?.('songchange', () => {
        for (const [kind, v] of views) {
            if (SOURCES[kind].from === 'main') v.content.scrollTop = 0;
        }
    });

    function unmountView(kind) {
        const v = views.get(kind);
        if (!v) return;
        views.delete(kind);
        if (SOURCES[kind].own) visualiser.unmount();
        try { v.root?.unmount(); } catch {}
        v.el.remove();
    }

    // Mount the pinned panels the layout places, unmount the rest.
    function syncViews() {
        const wanted = new Set(isOn() ? SLOTS.map(s => layout[s]).filter(src => SOURCES[src]?.pinned) : []);
        for (const kind of [...views.keys()]) if (!wanted.has(kind)) unmountView(kind);
        for (const kind of wanted) if (!views.has(kind)) mountView(kind);
    }

    // Re-render a pinned panel when an app-wide context value has changed.
    function refreshViews() {
        for (const [kind, v] of views) {
            const cap = captured[kind];
            if (!cap || !v.values) continue;
            const next = freshValues(cap);
            const changed = next.map((val, i) => (val !== v.values[i] ? i : -1)).filter(i => i >= 0);
            if (!changed.length) continue;
            // Kept for Henge.recon(): which context values keep changing.
            v.lastChanged = changed.map(i => ({ i, keys: valueKeys(next[i]) }));
            renderView(kind);
        }
    }

    setInterval(() => { if (isOn() && views.size) refreshViews(); }, 2000);

    // ── Visualiser ────────────────────────────────────────────────────────────
    // A Henge-drawn panel: a <canvas> animated from Spotify's audio analysis
    // for the current track (Spicetify.getAudioData(), i.e. spclient's
    // audio-attributes/v1/audio-analysis). Spotify doesn't expose the audio
    // itself, so the wave is rebuilt from the analysis against the playback
    // position: segments (~0.3s each) give a loudness curve and 12 pitch
    // values, beats give a pulse. Only spotify:track: URIs have analysis, so
    // local files show a message instead.

    const LS_VIS_STYLE = 'henge:visualiserStyle';
    const LS_VIS_COLOURS = 'henge:visualiserColours';
    const VIS_STYLES = { mirror: 'Mirrored wave', radial: 'Radial', line: 'Line', scroll: 'Scrolling waveform' };
    const VIS_COLOURS = { theme: 'Theme', album: 'Album art' };

    // ── Visualiser maths (pure; tools/test-visualiser.js extracts this block) ──

    const VIS_DB_FLOOR = -40;   // dB treated as silence
    const VIS_WINDOW = 16;      // seconds shown by the scrolling waveform

    const lerp = (a, b, f) => a + (b - a) * f;
    const clamp01 = v => Math.max(0, Math.min(1, v));
    const isTrackUri = uri => typeof uri === 'string' && uri.startsWith('spotify:track:');

    // Index of the item (segment, beat, bar, section) playing at t seconds:
    // the last one starting at or before t, or -1 before the first. `hint` is
    // the previous answer, usually still right or one short, which skips the
    // search.
    function indexAt(list, t, hint = -1) {
        const n = list.length;
        if (!n || t < list[0].start) return -1;
        if (hint >= 0 && hint < n && list[hint].start <= t) {
            if (hint + 1 >= n || list[hint + 1].start > t) return hint;
            if (hint + 2 >= n || list[hint + 2].start > t) return hint + 1;
        }
        let lo = 0, hi = n - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (list[mid].start <= t) lo = mid; else hi = mid - 1;
        }
        return lo;
    }

    // A segment's loudness (dB) at t: rises from loudness_start to
    // loudness_max at loudness_max_time, then heads for the next segment's
    // start (or silence after the last one).
    function loudnessAt(seg, next, t) {
        const dt = t - seg.start;
        const peak = seg.loudness_max_time ?? 0;
        if (dt <= peak) return lerp(seg.loudness_start, seg.loudness_max, peak > 0 ? clamp01(dt / peak) : 1);
        const end = next ? next.loudness_start : VIS_DB_FLOOR;
        const rest = seg.duration - peak;
        return lerp(seg.loudness_max, end, rest > 0 ? clamp01((dt - peak) / rest) : 1);
    }

    // dB to a 0…1 level, curved so quiet passages stay visibly lower.
    const dbToLevel = db => clamp01((db - VIS_DB_FLOOR) / -VIS_DB_FLOOR) ** 1.5;

    // 1 on a beat (or bar), fading with time constant tau.
    function beatPulse(beat, t, tau = 0.12) {
        if (!beat) return 0;
        const dt = t - beat.start;
        return dt < 0 ? 0 : Math.exp(-dt / tau);
    }

    // The 12 pitch values at t, blended from this segment's towards the next.
    function pitchesAt(seg, next, t) {
        const a = seg.pitches, b = next?.pitches ?? a;
        const f = clamp01((t - seg.start) / (seg.duration || 1));
        return a.map((p, i) => lerp(p, b[i] ?? p, f));
    }

    // Catmull-Rom between p1 and p2.
    const catmull = (p0, p1, p2, p3, f) => 0.5 * (2 * p1 + (p2 - p0) * f
        + (2 * p0 - 5 * p1 + 4 * p2 - p3) * f * f + (3 * p1 - p0 - 3 * p2 + p3) * f * f * f);

    // A smooth curve through the 12 pitch values, wrapping round (pitch
    // classes are cyclic): u in [0, 12).
    function chromaAt(p, u) {
        const i = Math.floor(u), f = u - i;
        const g = k => p[(((i + k) % 12) + 12) % 12];
        return catmull(g(-1), g(0), g(1), g(2), f);
    }

    // Eases v towards target with time constant tau (seconds) over dt.
    const ease = (v, target, dt, tau) => v + (target - v) * (1 - Math.exp(-dt / tau));

    // Mean and spread of some numbers (spread never 0).
    function spread(values) {
        const n = values.length || 1;
        const mean = values.reduce((s, v) => s + v, 0) / n;
        const sd = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / n);
        return { mean, sd: sd || 1 };
    }

    // The analysis reduced to what the visualiser draws from, plus per-track
    // ranges: timbre[1] (brightness) for the wave's edge, section loudness
    // for its energy. null when there's nothing to draw.
    function prepareTrack(raw) {
        const segments = raw?.segments;
        if (!Array.isArray(segments) || !segments.length) return null;
        const sections = raw.sections ?? [];
        const loud = sections.map(s => s.loudness).filter(Number.isFinite);
        const last = segments[segments.length - 1];
        return {
            segments,
            beats: raw.beats ?? [],
            bars: raw.bars ?? [],
            sections,
            duration: raw.track?.duration ?? last.start + last.duration,
            tempo: raw.track?.tempo || 120,
            bright: spread(segments.map(s => s.timbre?.[1] ?? 0)),
            loudMin: loud.length ? Math.min(...loud) : 0,
            loudMax: loud.length ? Math.max(...loud) : 0,
        };
    }

    // How bright a segment sounds next to the rest of its track, 0…1.
    function brightness(track, seg) {
        const z = ((seg.timbre?.[1] ?? track.bright.mean) - track.bright.mean) / track.bright.sd;
        return 1 / (1 + Math.exp(-1.5 * z));
    }

    // A section's loudness within its track's range, 0…1 (0.6 when flat).
    function sectionEnergy(track, section) {
        const range = track.loudMax - track.loudMin;
        if (!section || range < 0.5) return 0.6;
        return clamp01((section.loudness - track.loudMin) / range);
    }

    // [r, g, b] from "#rgb", "#rrggbb", "rgb(…)", or the colour extractor's
    // "#" + an ARGB number in hex (alpha ignored, may be negative).
    function parseColour(s) {
        s = String(s ?? '').trim();
        let m = s.match(/^#([0-9a-f]{3})$/i);
        if (m) return [...m[1]].map(h => parseInt(h + h, 16));
        m = s.match(/^#(-?[0-9a-f]{1,8})$/i);
        if (m) {
            const v = (parseInt(m[1], 16) >>> 0) & 0xffffff;
            return [v >> 16, (v >> 8) & 255, v & 255];
        }
        m = s.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i);
        return m ? [+m[1], +m[2], +m[3]] : null;
    }

    function rgbToHsl([r, g, b]) {
        r /= 255; g /= 255; b /= 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
        if (max === min) return [0, 0, l];
        const d = max - min;
        const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
        return [h * 60, s, l];
    }

    function hslToRgb([h, s, l]) {
        h = ((h % 360) + 360) % 360;
        const k = n => (n + h / 30) % 12;
        const a = s * Math.min(l, 1 - l);
        const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
        return [f(0), f(8), f(4)].map(v => Math.round(v * 255));
    }

    // Hue turned by deg; lightness raised to at least minL (dark album
    // colours vanish on Spotify's dark background).
    function adjustColour(rgb, { minL = 0, deg = 0 } = {}) {
        const [h, s, l] = rgbToHsl(rgb);
        return hslToRgb([h + deg, s, Math.max(l, minL)]);
    }

    const mixRgb = (a, b, f) => a.map((v, i) => lerp(v, b[i], f));
    const rgba = (c, alpha) => `rgba(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])}, ${alpha})`;

    // Three colours: a (the main wave), b (the back layer), c (highlights).
    function themePalette(accent, text) {
        const a = parseColour(accent) ?? [30, 215, 96];
        const t = parseColour(text) ?? [255, 255, 255];
        return { a, b: adjustColour(a, { deg: -35 }), c: mixRgb(a, t, 0.4) };
    }

    // From Spotify's colour extractor swatches for the album art; null
    // without a usable one.
    function albumPalette(swatches) {
        const pick = (...keys) => keys.map(k => parseColour(swatches?.[k])).find(Boolean);
        const a = pick('VIBRANT_NON_ALARMING', 'VIBRANT', 'PROMINENT');
        if (!a) return null;
        const b = pick('DARK_VIBRANT', 'PROMINENT', 'DESATURATED') ?? adjustColour(a, { deg: -35 });
        const c = pick('LIGHT_VIBRANT') ?? mixRgb(a, [255, 255, 255], 0.4);
        return {
            a: adjustColour(a, { minL: 0.5 }),
            b: adjustColour(b, { minL: 0.42 }),
            c: adjustColour(c, { minL: 0.62 }),
        };
    }


    // Smooth value noise in 0…1 from a hashed integer lattice.
    function hash2(x, y) {
        let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) | 0;
        h = Math.imul(h ^ (h >>> 13), 1274126177);
        return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
    }

    function noise2(x, y) {
        const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
        const sx = xf * xf * (3 - 2 * xf), sy = yf * yf * (3 - 2 * yf);
        const top = lerp(hash2(xi, yi), hash2(xi + 1, yi), sx);
        const bottom = lerp(hash2(xi, yi + 1), hash2(xi + 1, yi + 1), sx);
        return lerp(top, bottom, sy);
    }

    // How hard a segment hits, 0…1: its rise to peak, trusted as far as
    // the analysis is confident there's a new sound.
    const attackOf = seg => clamp01((seg.loudness_max - seg.loudness_start) / 18) * Math.sqrt(clamp01(seg.confidence ?? 1));

    // Spotify's extracted cover colours (fetchExtractedColors: raw, dark,
    // light) as swatches albumPalette() reads; null if all are fallbacks.
    function swatchesFromExtracted(e) {
        if (!e || (e.__typename && e.__typename !== 'ExtractedColors')) return null;
        const all = [e.colorRaw, e.colorDark, e.colorLight];
        if (all.every(c => !c?.hex || c.isFallback)) return null;
        return { VIBRANT: e.colorRaw?.hex, DARK_VIBRANT: e.colorDark?.hex, LIGHT_VIBRANT: e.colorLight?.hex };
    }

    const toHex = c => `#${c.map(v => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

    // Swatches from raw RGBA pixels, for when Spotify's extraction falls
    // back. Greyscale art (Spotify finds no vibrant colour in it) gives greys
    // from its own dark, mid and light tones; anything else, the strongest
    // of 12 hue bands.
    function swatchesFromPixels(data) {
        const px = [];
        for (let i = 0; i + 3 < data.length; i += 4) {
            if (data[i + 3] < 128) continue;
            const rgb = [data[i], data[i + 1], data[i + 2]];
            px.push({ rgb, hsl: rgbToHsl(rgb), chroma: (Math.max(...rgb) - Math.min(...rgb)) / 255 });
        }
        if (!px.length) return null;
        const bands = Array.from({ length: 12 }, () => ({ w: 0, sum: [0, 0, 0] }));
        for (const p of px) {
            if (p.chroma < 0.15) continue;
            const band = bands[Math.floor(p.hsl[0] / 30) % 12];
            band.w += p.chroma;
            band.sum = band.sum.map((v, i) => v + p.rgb[i] * p.chroma);
        }
        const best = bands.reduce((a, b) => (b.w > a.w ? b : a));
        const colourful = px.reduce((s, p) => s + p.chroma, 0) / px.length >= 0.08 && best.w > 0;
        if (!colourful) {
            const ls = px.map(p => p.hsl[2]).sort((a, b) => a - b);
            const grey = q => { const v = ls[Math.min(ls.length - 1, Math.floor(q * ls.length))] * 255; return toHex([v, v, v]); };
            return { VIBRANT: grey(0.6), DARK_VIBRANT: grey(0.2), LIGHT_VIBRANT: grey(0.95) };
        }
        const main = best.sum.map(v => v / best.w);
        const [h, sat, l] = rgbToHsl(main);
        return {
            VIBRANT: toHex(main),
            DARK_VIBRANT: toHex(hslToRgb([h, sat, l * 0.5])),
            LIGHT_VIBRANT: toHex(hslToRgb([h, sat * 0.6, Math.max(l, 0.8)])),
        };
    }

    // ── Visualiser view ──

    const visualiser = (() => {
        const MAX_PIXELS = 1.6e6;     // main canvas resolution cap
        const MAX_PARTICLES = 1400;
        const savedOr = (key, options, fallback) => {
            const v = lsGet(key);
            return Object.hasOwn(options, v ?? '') ? v : fallback;
        };
        let content = null, canvas = null, ctx = null, fx = null, fxCtx = null, msg = null;
        let resizeObs = null, housekeeping = null, needsFit = true;
        let style = savedOr(LS_VIS_STYLE, VIS_STYLES, 'mirror');
        let colourMode = savedOr(LS_VIS_COLOURS, VIS_COLOURS, 'theme');
        let theme = {};                     // --spice-* colour strings
        const cache = new Map();            // uri → prepared track (or null), the last few
        const swatchCache = new Map();      // uri → album colour swatches (or null)
        let uri = null, track = null, state = 'idle', error = null, token = 0;
        let swatches = null, swatchSource = null, swatchError = null;
        let raf = 0, lastFrame = 0, lastDrawnT = -1, scale = 1, wipe = true;
        // Animated values, eased every frame. kick: the last segment's hit;
        // heat: how intense things are overall, which most effects follow.
        let level = 0, edge = 0.5, energy = 0.6, bloom = 0, downbeat = 0, pulse = 0, kick = 0, heat = 0;
        let phase = 0, clock = 0, intro = 0;
        // whiteout: a split-second white flash on the biggest moments, never
        // more often than WHITEOUT_GAP seconds.
        const WHITEOUT_GAP = 5;
        let whiteout = 0, lastWhiteout = -Infinity, whiteouts = 0;
        let segIdx = -1, beatIdx = -1, barIdx = -1, secIdx = -1;
        let pitches = new Array(12).fill(0);
        let palette = null, goal = null;    // { a, b, c } as [r, g, b]; palette fades to goal
        let particles = [], shocks = [], bolts = [], grain = null;

        const MESSAGES = {
            idle: 'Play a song to see the visualiser.',
            loading: 'Loading visualiser data…',
            nodata: 'No visualiser data for this track.',
        };

        function remember(map, key, value) {
            map.set(key, value);
            while (map.size > 5) map.delete(map.keys().next().value);
        }

        // Spicetify themes set --spice-* on :root, and Spotify's CSS uses them.
        function readTheme() {
            const cs = getComputedStyle(html);
            const v = name => cs.getPropertyValue(name).trim();
            const next = {
                accent: v('--spice-button-active') || v('--spice-button') || '#1ed760',
                text: v('--spice-text') || '#ffffff',
                subdued: v('--spice-subtext') || '#b3b3b3',
            };
            const changed = JSON.stringify(next) !== JSON.stringify(theme);
            theme = next;
            if (changed) retarget();
            return changed;
        }

        function retarget() {
            goal = (colourMode === 'album' && albumPalette(swatches)) || themePalette(theme.accent, theme.text);
            palette ??= goal;
            wake();
        }

        function showState(next, err = null) {
            state = next;
            error = err;
            if (!msg) return;
            msg.replaceChildren();
            msg.hidden = state === 'ready';
            if (state === 'error') {
                const retry = document.createElement('button');
                retry.textContent = 'Retry';
                retry.addEventListener('click', () => { cache.delete(uri); load(); });
                msg.append(`Couldn't load visualiser data: ${error}`, retry);
            } else if (MESSAGES[state]) {
                msg.append(MESSAGES[state]);
            }
        }

        async function fetchAnalysis(u) {
            if (Spicetify.getAudioData) return Spicetify.getAudioData(u);
            return Spicetify.CosmosAsync.get(
                `https://spclient.wg.spotify.com/audio-attributes/v1/audio-analysis/${u.split(':')[2]}?format=json`);
        }

        // The cover's spotify:image: URI, which album colours are keyed by.
        function coverUri() {
            const m = Spicetify.Player?.data?.item?.metadata ?? {};
            return m.image_xlarge_url || m.image_large_url || m.image_url || '';
        }

        // Colours from the cover's own pixels, read from a 32px copy
        // (i.scdn.co allows cross-origin reads).
        function sampleCover(image) {
            const url = image.startsWith('spotify:image:') ? `https://i.scdn.co/image/${image.slice(14)}` : null;
            if (!url) return Promise.resolve(null);
            return new Promise(resolve => {
                const img = new Image();
                img.crossOrigin = 'anonymous';
                img.onload = () => {
                    try {
                        const c = document.createElement('canvas');
                        c.width = c.height = 32;
                        const cctx = c.getContext('2d', { willReadFrequently: true });
                        cctx.drawImage(img, 0, 0, 32, 32);
                        resolve(swatchesFromPixels(cctx.getImageData(0, 0, 32, 32).data));
                    } catch (e) {
                        swatchError = `cover pixels: ${e?.message ?? e}`;
                        resolve(null);
                    }
                };
                img.onerror = () => { swatchError = 'cover pixels: image failed to load'; resolve(null); };
                img.src = url;
            });
        }

        // Album colours: Spotify's own extraction (the GraphQL query its
        // Now Playing view uses), else the cover's pixels (Spotify falls
        // back on greyscale art), else Spicetify's older colorExtractor.
        async function fetchSwatches(u, image) {
            const G = Spicetify.GraphQL, def = G?.Definitions?.fetchExtractedColors;
            swatchError = null;
            if (image.startsWith('spotify:image:') && def && G.Request) {
                try {
                    const res = await G.Request(def, { imageUris: [image] });
                    const sw = swatchesFromExtracted(res?.data?.extractedColors?.[0]);
                    if (sw) { swatchSource = 'fetchExtractedColors'; return sw; }
                } catch (e) { swatchError = `fetchExtractedColors: ${e?.message ?? e}`; }
            }
            const sampled = await sampleCover(image);
            if (albumPalette(sampled)) { swatchSource = 'cover pixels'; return sampled; }
            if (Spicetify.colorExtractor) {
                try {
                    const sw = await Spicetify.colorExtractor(u);
                    if (albumPalette(sw)) { swatchSource = 'colorExtractor'; return sw; }
                } catch (e) { swatchError = `colorExtractor: ${e?.message ?? e}`; }
            }
            swatchSource = null;
            return null;
        }

        // Only fetched in album mode. The old colours stay until the new ones
        // arrive, so a song change is one crossfade.
        function loadSwatches(mine) {
            if (colourMode !== 'album' || !uri) {
                swatches = null;
                return retarget();
            }
            if (swatchCache.has(uri)) {
                swatches = swatchCache.get(uri);
                return retarget();
            }
            const u = uri;
            fetchSwatches(u, coverUri()).then(sw => {
                remember(swatchCache, u, sw);
                if (mine === token) { swatches = sw; retarget(); }
            });
        }

        // Loads the current track's analysis; a later call wins over a slow one.
        async function load() {
            const mine = ++token;
            uri = Spicetify.Player?.data?.item?.uri ?? null;
            track = null;
            segIdx = beatIdx = barIdx = secIdx = -1;
            wipe = true;
            loadSwatches(mine);
            if (!uri) return showState('idle');
            if (!isTrackUri(uri)) return showState('nodata');
            if (cache.has(uri)) {
                track = cache.get(uri);
                return showState(track ? 'ready' : 'nodata');
            }
            showState('loading');
            try {
                const raw = await fetchAnalysis(uri);
                if (mine !== token) return;
                track = prepareTrack(raw);
                remember(cache, uri, track);
                showState(track ? 'ready' : 'nodata');
            } catch (e) {
                if (mine !== token) return;
                warn('visualiser data:', e);
                showState('error', e?.message ?? String(e));
            }
            wake();
        }

        // Done in the next frame rather than on every resize notification:
        // resizing a canvas reallocates it.
        function fitCanvas() {
            needsFit = false;
            const cw = content.clientWidth, ch = content.clientHeight;
            scale = Math.min(window.devicePixelRatio || 1, Math.sqrt(MAX_PIXELS / Math.max(1, cw * ch)));
            const w = Math.round(cw * scale), h = Math.round(ch * scale);
            if (canvas.width !== w || canvas.height !== h) {
                canvas.width = w;
                canvas.height = h;
                particles = []; shocks = []; bolts = [];
            }
            // Grain and flashes don't need full resolution.
            const fw = Math.round(cw * Math.min(1, scale)), fh = Math.round(ch * Math.min(1, scale));
            if (fx.width !== fw || fx.height !== fh) { fx.width = fw; fx.height = fh; }
        }

        // getProgress() throws before anything has played (no player state).
        const progress = () => {
            try { return (Spicetify.Player?.getProgress?.() ?? 0) / 1000; } catch { return 0; }
        };
        const playing = () => !!Spicetify.Player?.isPlaying?.();
        const random = (lo, hi) => lo + Math.random() * (hi - lo);

        // Back to front. The back layers come in as a section gets louder.
        const layers = () => [
            { k: 1.2, speed: 0.55, offset: 4, alpha: 0.06 + 0.2 * energy, colour: palette.b },
            { k: 0.85, speed: 1.5, offset: 8, alpha: 0.08 + 0.18 * energy, colour: palette.c },
            { k: 1, speed: 1, offset: 0, alpha: 1, colour: palette.a, front: true },
        ];

        // Height (0…1) of a wave layer at x (0…1): the level, shaped by the
        // pitch curve drifting across, roughened by noise that turns into a
        // crackle on hard hits. `taper` brings it to nothing at the ends
        // (the ring wraps instead).
        function amplitude(x, layer, taper) {
            const u = ((x * 12 + phase * layer.speed + layer.offset) % 12 + 12) % 12;
            const c = clamp01(chromaAt(pitches, u));
            const shape = 0.25 + 0.75 * c ** (1 + 3 * edge);
            const wobble = noise2(x * 14 + layer.offset * 5, clock * (4 + 6 * kick)) - 0.5;
            const crackle = noise2(x * 80 + layer.offset * 11, clock * 30) - 0.5;
            const rough = 1 + (0.35 + 1.1 * kick + 0.4 * edge) * wobble + (0.15 + 0.9 * kick) * (0.4 + edge) * crackle;
            const lift = (0.7 + 0.45 * energy) * (1 + 0.35 * downbeat + 0.15 * pulse + 0.25 * bloom + 0.6 * kick);
            const end = taper ? Math.sin(Math.PI * x) ** 0.6 : 1;
            return clamp01(level * intro * shape * lift * layer.k * rough * end);
        }

        // A hot edge: wide soft passes added on top, then a bright core.
        function glowStroke(colour, core = 2) {
            ctx.lineJoin = 'round';
            ctx.globalCompositeOperation = 'lighter';
            ctx.strokeStyle = rgba(colour, 0.05 + 0.1 * heat);
            ctx.lineWidth = (12 + 14 * downbeat + 10 * kick) * scale;
            ctx.stroke();
            ctx.strokeStyle = rgba(colour, 0.18);
            ctx.lineWidth = 5 * scale;
            ctx.stroke();
            ctx.globalCompositeOperation = 'source-over';
            ctx.strokeStyle = rgba(mixRgb(colour, [255, 255, 255], 0.35 + 0.4 * kick), 1);
            ctx.lineWidth = core * scale;
            ctx.stroke();
        }

        // Hard hits split the edge into red and cyan ghosts.
        function split(path, colour) {
            const off = (kick * 7 + bloom * 5) * scale;
            if (off < 0.8 * scale) return;
            ctx.globalCompositeOperation = 'lighter';
            ctx.lineWidth = 1.5 * scale;
            for (const [dx, tint] of [[-off, [255, 40, 90]], [off, [40, 220, 255]]]) {
                ctx.save();
                ctx.translate(dx, 0);
                path();
                ctx.strokeStyle = rgba(mixRgb(colour, tint, 0.6), 0.6 * Math.min(1, kick + bloom));
                ctx.stroke();
                ctx.restore();
            }
            ctx.globalCompositeOperation = 'source-over';
        }

        // Inside a wave's body (clipped to it): drifting plasma, ripples
        // running out from the middle to the edge, and a hot core. `ripple`
        // draws the body's outline scaled by f (0 = the middle, 1 = the edge).
        function interior({ body, ripple, core, cx, cy, w, h }) {
            ctx.save();
            body();
            ctx.clip('evenodd');
            ctx.globalCompositeOperation = 'lighter';
            for (let i = 0; i < 4; i++) {
                const bx = cx + (noise2(i * 7.3, clock * 0.35) - 0.5) * w * 1.1;
                const by = cy + (noise2(i * 3.1 + 50, clock * 0.5) - 0.5) * h * 0.6;
                const br = (0.3 + 0.25 * noise2(i + 20, clock * 0.8)) * Math.max(w, h) * 0.5 * (0.5 + 0.7 * level);
                const g = ctx.createRadialGradient(bx, by, 0, bx, by, br);
                g.addColorStop(0, rgba(i % 2 ? palette.b : palette.c, 0.2 + 0.25 * kick + 0.1 * energy));
                g.addColorStop(1, rgba(palette.b, 0));
                ctx.fillStyle = g;
                ctx.fillRect(bx - br, by - br, 2 * br, 2 * br);
            }
            const hot = mixRgb(palette.a, [255, 255, 255], 0.55);
            for (let k = 0; k < 6; k++) {
                const f = (k / 6 + clock * (0.3 + 0.7 * level)) % 1;
                ripple(f);
                ctx.strokeStyle = rgba(hot, 4 * f * (1 - f) * (0.1 + 0.4 * downbeat + 0.3 * kick + 0.1 * energy));
                ctx.lineWidth = (1 + 2.5 * downbeat) * scale;
                ctx.stroke();
            }
            core(hot);
            ctx.restore();
        }

        // Each wave style draws itself and returns its geometry for the
        // effects: where sparks leave from (crest), how they're pulled
        // (accel), the shape of a shockwave, and a size to scale speeds by.

        function drawMirror(W, H) {
            const mid = H / 2, max = mid - 8 * scale;
            const n = Math.max(2, Math.min(260, Math.round(W / (3 * scale))));
            ctx.fillStyle = rgba(palette.c, 0.12 + 0.5 * downbeat + 0.3 * kick);
            ctx.fillRect(0, mid - scale / 2, W, scale);
            let front = null;
            for (const layer of layers()) {
                const amps = Array.from({ length: n + 1 }, (_, i) => amplitude(i / n, layer, true));
                const outline = () => {
                    ctx.beginPath();
                    ctx.moveTo(0, mid);
                    for (let i = 1; i <= n; i++) ctx.lineTo(i / n * W, mid - amps[i] * max);
                    for (let i = n; i >= 0; i--) ctx.lineTo(i / n * W, mid + amps[i] * max);
                    ctx.closePath();
                };
                outline();
                if (!layer.front) {
                    ctx.fillStyle = rgba(layer.colour, layer.alpha);
                    ctx.fill();
                    continue;
                }
                const g = ctx.createLinearGradient(0, mid - max, 0, mid + max);
                g.addColorStop(0, rgba(layer.colour, 0.04));
                g.addColorStop(0.5, rgba(layer.colour, 0.3 + 0.15 * downbeat));
                g.addColorStop(1, rgba(layer.colour, 0.04));
                ctx.fillStyle = g;
                ctx.fill();
                interior({
                    body: outline, cx: W / 2, cy: mid, w: W, h: H,
                    ripple: f => {
                        ctx.beginPath();
                        for (let i = 0; i <= n; i++) ctx.lineTo(i / n * W, mid - amps[i] * max * f);
                        for (let i = n; i >= 0; i--) ctx.lineTo(i / n * W, mid + amps[i] * max * f);
                        ctx.closePath();
                    },
                    // A white-hot band along the middle, swelling on hits.
                    core: hot => {
                        const half = max * (0.06 + 0.22 * level + 0.3 * kick + 0.15 * bloom);
                        const band = ctx.createLinearGradient(0, mid - half, 0, mid + half);
                        band.addColorStop(0, rgba(hot, 0));
                        band.addColorStop(0.5, rgba([255, 255, 255], 0.2 + 0.45 * kick + 0.25 * downbeat));
                        band.addColorStop(1, rgba(hot, 0));
                        ctx.fillStyle = band;
                        ctx.fillRect(0, mid - half, W, 2 * half);
                    },
                });
                glowStroke(layer.colour);
                split(outline, layer.colour);
                front = amps;
            }
            return {
                size: H,
                crest() {
                    let i = 0, best = -1;
                    for (let k = 0; k < 3; k++) {
                        const j = Math.floor(Math.random() * (n + 1));
                        if (front[j] > best) { best = front[j]; i = j; }
                    }
                    const up = Math.random() < 0.5 ? -1 : 1;
                    return { x: i / n * W, y: mid + up * front[i] * max, nx: 0, ny: up };
                },
                // Sparks are pulled back towards the centre line; embers drift out.
                accel: p => [0, (p.y < mid ? 1 : -1) * (p.ember ? -0.12 : 1.1) * H],
                shock(f) {
                    ctx.beginPath();
                    ctx.ellipse(W / 2, mid, Math.max(1, f * W * 0.55), Math.max(1, f * H * 0.65), 0, 0, 2 * Math.PI);
                },
            };
        }

        // The wave wrapped into a ring around a glowing core, with ripples
        // expanding out of it.
        function drawRadial(W, H) {
            const cx = W / 2, cy = H / 2, m = Math.min(W, H);
            const R = m * 0.27, span = m * 0.2, n = 220;
            const r = R * 0.75 * (1 + 0.06 * downbeat + 0.08 * kick);
            const hot = mixRgb(palette.a, [255, 255, 255], 0.55);
            ctx.globalCompositeOperation = 'lighter';
            const orb = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
            orb.addColorStop(0, rgba([255, 255, 255], 0.15 + 0.4 * kick + 0.2 * bloom));
            orb.addColorStop(0.35, rgba(palette.c, 0.18 + 0.2 * level + 0.15 * downbeat));
            orb.addColorStop(1, rgba(palette.a, 0));
            ctx.fillStyle = orb;
            ctx.fillRect(cx - r, cy - r, 2 * r, 2 * r);
            for (let k = 0; k < 5; k++) {
                const f = (k / 5 + clock * (0.25 + 0.6 * level)) % 1;
                ctx.beginPath();
                ctx.arc(cx, cy, Math.max(1, f * r), 0, 2 * Math.PI);
                ctx.strokeStyle = rgba(hot, 4 * f * (1 - f) * (0.08 + 0.35 * downbeat + 0.25 * kick));
                ctx.lineWidth = (1 + 2 * downbeat) * scale;
                ctx.stroke();
            }
            ctx.globalCompositeOperation = 'source-over';

            const point = (i, rad) => {
                const th = i / n * 2 * Math.PI - Math.PI / 2;
                return [cx + Math.cos(th) * rad, cy + Math.sin(th) * rad, Math.cos(th), Math.sin(th)];
            };
            const ring = (amps, radius) => {
                amps.forEach((a, i) => {
                    const [x, y] = point(i, radius(a));
                    if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
                });
                ctx.closePath();
            };
            let front = null;
            for (const layer of layers()) {
                const amps = Array.from({ length: n }, (_, i) => amplitude(i / n, layer, false));
                ctx.beginPath();
                ring(amps, a => R + a * span);
                ring(amps, a => R - a * span * 0.25);
                if (!layer.front) {
                    ctx.fillStyle = rgba(layer.colour, layer.alpha);
                    ctx.fill('evenodd');
                    continue;
                }
                const g = ctx.createRadialGradient(cx, cy, R - span * 0.25, cx, cy, R + span);
                g.addColorStop(0, rgba(layer.colour, 0.25));
                g.addColorStop(0.2, rgba(layer.colour, 0.35 + 0.15 * downbeat));
                g.addColorStop(1, rgba(layer.colour, 0.03));
                ctx.fillStyle = g;
                ctx.fill('evenodd');
                const body = () => {
                    ctx.beginPath();
                    ring(amps, a => R + a * span);
                    ring(amps, a => R - a * span * 0.25);
                };
                interior({
                    body, cx, cy, w: 2 * (R + span), h: 2 * (R + span),
                    ripple: f => { ctx.beginPath(); ring(amps, a => R + a * span * f); },
                    // A white-hot line round the ring's base.
                    core: hotCore => {
                        ctx.beginPath();
                        ctx.arc(cx, cy, R, 0, 2 * Math.PI);
                        ctx.strokeStyle = rgba(hotCore, 0.25 + 0.5 * kick + 0.25 * downbeat);
                        ctx.lineWidth = (2 + 6 * level + 6 * kick) * scale;
                        ctx.stroke();
                    },
                });
                const outer = () => { ctx.beginPath(); ring(amps, a => R + a * span); };
                outer();
                glowStroke(layer.colour);
                split(outer, layer.colour);
                front = amps;
            }
            return {
                size: m,
                crest() {
                    const i = Math.floor(Math.random() * n);
                    const [x, y, nx, ny] = point(i, R + front[i] * span);
                    return { x, y, nx, ny };
                },
                // Sparks fly free; embers swirl round the ring.
                accel: p => {
                    if (!p.ember) return [0, 0];
                    const dx = p.x - cx, dy = p.y - cy, d = Math.hypot(dx, dy) || 1;
                    return [(-dy / d * 0.25 + dx / d * 0.05) * m, (dx / d * 0.25 + dy / d * 0.05) * m];
                },
                shock(f) {
                    ctx.beginPath();
                    ctx.arc(cx, cy, R + f * m * 0.7, 0, 2 * Math.PI);
                },
            };
        }

        // An oscilloscope trace under the wave's envelope, with a fainter
        // echo behind it.
        function drawLine(W, H) {
            const mid = H / 2, max = mid - 8 * scale;
            const n = Math.max(2, Math.min(260, Math.round(W / (3 * scale))));
            const ys = (layer, cycles, shift) => Array.from({ length: n + 1 }, (_, i) => {
                const x = i / n;
                return mid - amplitude(x, layer, true) * max * Math.sin(2 * Math.PI * cycles * x - phase * 2.5 * layer.speed + shift);
            });
            const path = pts => () => {
                ctx.beginPath();
                pts.forEach((y, i) => { if (i) ctx.lineTo(i / n * W, y); else ctx.moveTo(0, y); });
            };
            const [back, , frontLayer] = layers();
            const echo = path(ys(back, 3, 1.3));
            echo();
            ctx.strokeStyle = rgba(palette.b, 0.55);
            ctx.lineWidth = 1.5 * scale;
            ctx.stroke();
            const front = ys(frontLayer, 4, 0);
            const trace = path(front);
            trace();
            glowStroke(palette.a);
            split(trace, palette.a);
            return {
                size: H,
                crest() {
                    const i = Math.floor(Math.random() * (n + 1));
                    return { x: i / n * W, y: front[i], nx: 0, ny: front[i] < mid ? -1 : 1 };
                },
                accel: p => [0, (p.y < mid ? 1 : -1) * (p.ember ? -0.12 : 1.1) * H],
                shock(f) {
                    ctx.beginPath();
                    ctx.ellipse(W / 2, mid, Math.max(1, f * W * 0.55), Math.max(1, f * H * 0.65), 0, 0, 2 * Math.PI);
                },
            };
        }

        // The track's loudness as bars scrolling past a centre "now" marker.
        function drawScroll(W, H, t) {
            const mid = H / 2, max = mid - 4 * scale;
            const barW = 3 * scale, step = 5 * scale;
            const segs = track.segments;
            const dtBar = VIS_WINDOW * step / W;
            const played = theme.subdued, coming = rgba(palette.a, 1);
            let idx = -1;
            for (let tb = Math.ceil((t - VIS_WINDOW / 2) / dtBar) * dtBar; ; tb += dtBar) {
                const x = W / 2 + (tb - t) / VIS_WINDOW * W;
                if (x > W) break;
                if (tb < 0 || tb > track.duration) continue;
                idx = indexAt(segs, tb, idx);
                if (idx < 0) continue;
                const h = Math.max(scale, dbToLevel(loudnessAt(segs[idx], segs[idx + 1], tb)) * max);
                ctx.fillStyle = tb < t ? played : coming;
                ctx.fillRect(x - barW / 2, mid - h, barW, 2 * h);
            }
            ctx.globalAlpha = 0.8;
            ctx.fillStyle = theme.text;
            ctx.fillRect(W / 2 - scale, 0, 2 * scale, H);
            ctx.globalAlpha = 1;
        }

        // A jagged bolt from the crest outwards, gone in a fraction of a second.
        function bolt(geo) {
            const c = geo.crest();
            const len = geo.size * random(0.25, 0.6), steps = 10;
            let x = c.x, y = c.y;
            const pts = [[x, y]];
            for (let i = 0; i < steps; i++) {
                x += c.nx * len / steps + random(-0.5, 0.5) * len * 0.3;
                y += c.ny * len / steps + random(-0.5, 0.5) * len * 0.3;
                pts.push([x, y]);
            }
            bolts.push({ pts, life: 1 });
        }

        // New sparks and embers: a steady stream that grows with the music,
        // bursts on hits and downbeats, a blast on a new section.
        function spawn(geo, ev, dt) {
            let count = Math.floor((20 + 320 * heat) * level * intro * dt + Math.random());
            if (ev.kick > 0.15) count += Math.round(ev.kick * (12 + 55 * heat));
            if (ev.downbeat) {
                count += Math.round(15 + 45 * heat);
                if (heat > 0.35) shocks.push({ age: 0, power: heat });
                if (heat > 0.6 && Math.random() < heat) bolt(geo);
            }
            if (ev.whiteout) {
                count += 260;
                shocks.push({ age: 0, power: 2 });
                for (let i = 0; i < 5; i++) bolt(geo);
            }
            if (ev.section) {
                count += 220;
                shocks.push({ age: 0, power: 1.4 });
                bolt(geo); bolt(geo); bolt(geo);
            }
            for (let i = 0; i < count && particles.length < MAX_PARTICLES; i++) {
                const c = geo.crest(), ember = Math.random() < 0.25;
                const speed = (ember ? random(0.03, 0.1) : random(0.2, 1) * (0.5 + kick + 0.6 * heat)) * geo.size;
                const turn = random(-0.5, 0.5) * (ember ? 1.4 : 1);
                const cos = Math.cos(turn), sin = Math.sin(turn);
                particles.push({
                    x: c.x, y: c.y, ember, seed: Math.random() * 100, life: 1,
                    vx: (c.nx * cos - c.ny * sin) * speed, vy: (c.nx * sin + c.ny * cos) * speed,
                    decay: 1 / (ember ? random(1.2, 2.8) : random(0.3, 0.9)),
                });
            }
        }

        function drawEffects(geo, dt) {
            ctx.globalCompositeOperation = 'lighter';
            // Shockwaves: rings expanding out from the wave.
            shocks = shocks.filter(s => (s.age += dt) < 0.6);
            for (const s of shocks) {
                const f = s.age / 0.6;
                geo.shock(f);
                ctx.strokeStyle = rgba(palette.c, (1 - f) ** 2 * 0.45 * s.power);
                ctx.lineWidth = (1 + 4 * (1 - f)) * scale;
                ctx.stroke();
            }
            // Bolts: a coloured halo, then a white-hot core.
            bolts = bolts.filter(b => (b.life -= dt / 0.18) > 0);
            for (const b of bolts) {
                ctx.beginPath();
                b.pts.forEach(([x, y], i) => { if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
                ctx.strokeStyle = rgba(palette.a, 0.35 * b.life);
                ctx.lineWidth = 7 * scale;
                ctx.stroke();
                ctx.strokeStyle = rgba(mixRgb(palette.c, [255, 255, 255], 0.7), b.life);
                ctx.lineWidth = 1.5 * scale;
                ctx.stroke();
            }
            // Particles: move, then draw sparks as streaks in four batches
            // (white-hot when new, cooling to the palette) and embers as
            // flickering motes.
            const drag = Math.exp(-dt * 1.8);
            particles = particles.filter(p => (p.life -= dt * p.decay) > 0);
            for (const p of particles) {
                const [ax, ay] = geo.accel(p);
                p.vx = (p.vx + ax * dt) * drag;
                p.vy = (p.vy + ay * dt) * drag;
                if (p.ember) p.vx += (noise2(p.seed, clock * 2) - 0.5) * geo.size * 0.4 * dt;
                p.x += p.vx * dt;
                p.y += p.vy * dt;
            }
            for (let band = 0; band < 4; band++) {
                ctx.beginPath();
                let any = false;
                for (const p of particles) {
                    if (p.ember || Math.min(3, Math.floor(p.life * 4)) !== band) continue;
                    ctx.moveTo(p.x, p.y);
                    ctx.lineTo(p.x - p.vx * 0.03, p.y - p.vy * 0.03);
                    any = true;
                }
                if (!any) continue;
                const f = (band + 0.5) / 4;
                ctx.strokeStyle = rgba(mixRgb(palette.a, [255, 255, 255], f * 0.85), 0.3 + 0.7 * f);
                ctx.lineWidth = (0.8 + 1.6 * f) * scale;
                ctx.stroke();
            }
            for (const p of particles) {
                if (!p.ember) continue;
                const size = (1 + 2.5 * p.life) * scale;
                ctx.fillStyle = rgba(palette.c, 0.7 * p.life * (0.4 + 0.6 * noise2(p.seed, clock * 12)));
                ctx.fillRect(p.x - size / 2, p.y - size / 2, size, size);
            }
            ctx.globalCompositeOperation = 'source-over';
        }

        // Film grain and flashes go on their own canvas above the wave, so
        // the trails don't smear them.
        function grainPattern() {
            if (grain) return grain;
            const tile = document.createElement('canvas');
            tile.width = tile.height = 96;
            const tctx = tile.getContext('2d');
            const img = tctx.createImageData(96, 96);
            for (let i = 0; i < img.data.length; i += 4) {
                const v = Math.random() * 255;
                img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
                img.data[i + 3] = Math.random() < 0.55 ? 0 : Math.random() * 255;
            }
            tctx.putImageData(img, 0, 0);
            grain = fxCtx.createPattern(tile, 'repeat');
            return grain;
        }

        function drawFx(on) {
            const W = fx.width, H = fx.height;
            fxCtx.clearRect(0, 0, W, H);
            if (whiteout > 0.01 && W && H) {
                fxCtx.fillStyle = `rgba(255, 255, 255, ${0.92 * whiteout})`;
                fxCtx.fillRect(0, 0, W, H);
            }
            if (!on || state !== 'ready' || style === 'scroll' || !W || !H) return;
            const flash = 0.09 * downbeat * heat + 0.25 * bloom + 0.06 * kick;
            if (flash > 0.01) {
                const g = fxCtx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.6);
                g.addColorStop(0, rgba(palette.a, flash));
                g.addColorStop(1, rgba(palette.a, 0));
                fxCtx.fillStyle = g;
                fxCtx.fillRect(0, 0, W, H);
            }
            const pattern = grainPattern();
            if (!pattern) return;
            fxCtx.save();
            fxCtx.globalAlpha = 0.05 + 0.07 * heat + 0.1 * kick;
            fxCtx.translate(-Math.random() * 96, -Math.random() * 96);
            fxCtx.fillStyle = pattern;
            fxCtx.fillRect(0, 0, W + 96, H + 96);
            fxCtx.restore();
        }

        function frame(now) {
            raf = 0;
            if (!canvas) return;
            if (needsFit) fitCanvas();
            // Capped, so a slow frame doesn't throw everything forwards.
            const dt = lastFrame ? Math.min(0.05, (now - lastFrame) / 1000) : 0;
            lastFrame = now;
            const t = progress(), on = playing();
            let levelTo = 0, beat = 0, bar = 0, edgeTo = edge, energyTo = energy, peak = 0;
            // Events only fire as playback moves on, not when seeking.
            const ev = { kick: 0, downbeat: false, section: false, whiteout: false };
            if (state === 'ready' && on) {
                const segs = track.segments;
                const prevSeg = segIdx;
                segIdx = indexAt(segs, t, segIdx);
                if (segIdx >= 0) {
                    const seg = segs[segIdx], next = segs[segIdx + 1];
                    levelTo = dbToLevel(loudnessAt(seg, next, t));
                    const p = pitchesAt(seg, next, t);
                    pitches = pitches.map((v, i) => ease(v, p[i], dt, 0.08));
                    edgeTo = brightness(track, seg);
                    if (segIdx === prevSeg + 1) {
                        ev.kick = attackOf(seg);
                        peak = dbToLevel(seg.loudness_max);
                    }
                }
                beatIdx = indexAt(track.beats, t, beatIdx);
                beat = beatPulse(track.beats[beatIdx], t);
                const prevBar = barIdx;
                barIdx = indexAt(track.bars, t, barIdx);
                bar = beatPulse(track.bars[barIdx], t, 0.25);
                ev.downbeat = barIdx >= 0 && barIdx === prevBar + 1;
                const prevSec = secIdx;
                secIdx = indexAt(track.sections, t, secIdx);
                energyTo = sectionEnergy(track, track.sections[secIdx]);
                ev.section = secIdx > 0 && secIdx === prevSec + 1;
                // The biggest moments white out: a very hard, very loud hit
                // in an intense stretch, or a new section near the loudest.
                const bigHit = ev.kick >= 0.75 && peak > 0.75 && heat > 0.7;
                const bigSection = ev.section && energyTo > 0.8;
                if ((bigHit || bigSection) && style !== 'scroll' && clock - lastWhiteout > WHITEOUT_GAP) {
                    ev.whiteout = true;
                    whiteout = 1;
                    lastWhiteout = clock;
                    whiteouts++;
                }
            }
            level = ease(level, levelTo, dt, 0.05);
            edge = ease(edge, edgeTo, dt, 0.2);
            energy = ease(energy, energyTo, dt, 1);
            pulse = ease(pulse, beat, dt, 0.02);
            downbeat = ease(downbeat, bar, dt, 0.02);
            kick = Math.max(kick * Math.exp(-dt / 0.09), ev.kick);
            if (ev.section) bloom = 1;
            bloom *= Math.exp(-dt / 0.9);
            whiteout *= Math.exp(-dt / 0.07);
            intro = state === 'ready' ? Math.min(1, intro + dt / 0.6) : 0;
            heat = clamp01(0.45 * level + 0.55 * energy + 0.3 * bloom);
            clock += dt;
            phase += dt * (0.6 + 2.2 * level + 1.5 * kick);
            const fade = 1 - Math.exp(-dt / 0.5);
            if (palette && goal) palette = { a: mixRgb(palette.a, goal.a, fade), b: mixRgb(palette.b, goal.b, fade), c: mixRgb(palette.c, goal.c, fade) };

            const W = canvas.width, H = canvas.height;
            if (W && H) {
                if (style === 'scroll' || wipe || !dt || state !== 'ready') {
                    ctx.clearRect(0, 0, W, H);
                } else {
                    // Trails: fade what's there instead of clearing it.
                    ctx.globalCompositeOperation = 'destination-out';
                    ctx.fillStyle = `rgba(0, 0, 0, ${1 - Math.exp(-dt / 0.07)})`;
                    ctx.fillRect(0, 0, W, H);
                    ctx.globalCompositeOperation = 'source-over';
                }
                wipe = false;
                if (state === 'ready' && palette) {
                    if (style === 'scroll') {
                        drawScroll(W, H, t);
                    } else {
                        // A shake on downbeats, harder when it's loud.
                        const shake = (4 * downbeat * heat + 3 * kick * heat + 12 * whiteout) * scale;
                        ctx.save();
                        ctx.translate((noise2(clock * 40, 1) - 0.5) * 2 * shake, (noise2(clock * 40, 9) - 0.5) * 2 * shake);
                        const geo = style === 'radial' ? drawRadial(W, H) : style === 'line' ? drawLine(W, H) : drawMirror(W, H);
                        if (on) spawn(geo, ev, dt);
                        drawEffects(geo, dt);
                        ctx.restore();
                    }
                }
                drawFx(on);
            }
            lastDrawnT = t;
            // Paused (or nothing to show): stop once everything has settled.
            // Housekeeping restarts it if anything changes.
            const fading = palette && goal && ['a', 'b', 'c'].some(k => palette[k].some((v, i) => Math.abs(v - goal[k][i]) > 0.5));
            const still = style === 'scroll' || (level < 0.002 && kick < 0.01 && bloom < 0.01 && whiteout < 0.01
                && !particles.length && !shocks.length && !bolts.length);
            if ((on || !still || fading) && state === 'ready' && W && H) raf = requestAnimationFrame(frame);
            else lastFrame = 0;
        }

        function wake() {
            if (canvas && !raf) raf = requestAnimationFrame(frame);
        }

        const onSong = () => { load(); wake(); };
        const onPlayPause = () => wake();

        function mount(el) {
            unmount();
            content = el;
            canvas = document.createElement('canvas');
            ctx = canvas.getContext('2d');
            fx = document.createElement('canvas');
            fxCtx = fx.getContext('2d');
            msg = document.createElement('div');
            msg.className = 'henge-view-msg';
            content.append(canvas, fx, msg);
            needsFit = true;
            resizeObs = new ResizeObserver(() => { needsFit = true; wipe = true; wake(); });
            resizeObs.observe(content);
            Spicetify.Player?.addEventListener?.('songchange', onSong);
            Spicetify.Player?.addEventListener?.('onplaypause', onPlayPause);
            // Theme colours can change live (Marketplace), and a seek while
            // paused fires no event: check both now and then.
            housekeeping = setInterval(() => {
                const recoloured = readTheme();
                if (recoloured || playing() || Math.abs(progress() - lastDrawnT) > 0.05) wake();
            }, 1000);
            readTheme();
            load();
            wake();
        }

        function unmount() {
            if (!canvas) return;
            cancelAnimationFrame(raf);
            raf = 0;
            lastFrame = 0;
            clearInterval(housekeeping);
            resizeObs?.disconnect();
            Spicetify.Player?.removeEventListener?.('songchange', onSong);
            Spicetify.Player?.removeEventListener?.('onplaypause', onPlayPause);
            canvas.remove();
            fx.remove();
            msg.remove();
            content = canvas = ctx = fx = fxCtx = msg = resizeObs = housekeeping = grain = null;
            token++;
            level = bloom = kick = intro = whiteout = 0;
            particles = []; shocks = []; bolts = [];
        }

        function setStyle(next) {
            if (!Object.hasOwn(VIS_STYLES, next)) return;
            style = next;
            lsSet(LS_VIS_STYLE, next);
            particles = []; shocks = []; bolts = [];
            wipe = true;
            wake();
        }

        function setColours(next) {
            if (!Object.hasOwn(VIS_COLOURS, next)) return;
            colourMode = next;
            lsSet(LS_VIS_COLOURS, next);
            loadSwatches(token);
        }

        const hex = c => c && toHex(c);
        const info = () => ({
            mounted: !!canvas, style, colours: colourMode, state, error, uri,
            segments: track?.segments.length ?? null,
            beats: track?.beats.length ?? null,
            bars: track?.bars.length ?? null,
            sections: track?.sections.length ?? null,
            canvas: canvas ? [canvas.width, canvas.height] : null, scale,
            running: !!raf, theme, swatches, swatchSource, swatchError,
            palette: palette && { a: hex(palette.a), b: hex(palette.b), c: hex(palette.c) },
            energy: +energy.toFixed(2), edge: +edge.toFixed(2), heat: +heat.toFixed(2),
            particles: particles.length, shocks: shocks.length, bolts: bolts.length,
            whiteouts, cached: cache.size,
        });

        return {
            mount, unmount, setStyle, setColours, info,
            get style() { return style; },
            get colours() { return colourMode; },
        };
    })();

    // ── Watching Spotify ──────────────────────────────────────────────────────
    // Targeted observers on the library (its class and inline width change with
    // collapse / expand) and the root's children. A slow poll re-hooks them if
    // React replaces the root or the library, and puts Henge's elements back.

    let hooked = { root: null, left: null };
    let pending = false;

    function schedule() {
        if (pending) return;
        pending = true;
        requestAnimationFrame(() => {
            pending = false;
            if (!isOn()) return;
            try {
                updateState();
                // Mid-drag the handle owns the size; don't snap it back.
                if (!html.classList.contains('henge-resizing')) applyColumn();
            } catch (e) { warn('update failed:', e); }
        });
    }

    const observer = new MutationObserver(schedule);

    function hook() {
        const root = getRoot();
        const left = document.getElementById(LEFT_ID);
        if (root === hooked.root && left === hooked.left && rowHandle.parentElement === root) return;
        observer.disconnect();
        if (root) {
            observer.observe(root, { childList: true });
            ensureExtras(root);
        }
        if (left) observer.observe(left, { attributes: true, attributeFilter: ['class', 'style'] });
        const placeholder = left?.previousElementSibling;
        if (placeholder) observer.observe(placeholder, { attributes: true, attributeFilter: ['class', 'style'] });
        // Expand / minimise are animated: Spotify keeps the placeholder visible
        // while <html> carries data-transition / data-cinema-library-* attributes,
        // so the state must be re-read once those change.
        observer.observe(html, { attributes: true });
        hooked = { root, left };
        applySizes();
        schedule();
    }

    // Also a safety net for any state change the observers miss.
    setInterval(() => { if (isOn()) { hook(); schedule(); } }, 1000);

    let resizePending = false;
    window.addEventListener('resize', () => {
        if (resizePending || !isOn()) return;
        resizePending = true;
        requestAnimationFrame(() => { resizePending = false; applySizes(); });
    });

    // ── Styles ────────────────────────────────────────────────────────────────

    function styleTag(id) {
        let el = document.getElementById(id);
        if (!el) {
            el = document.createElement('style');
            el.id = id;
            document.head.appendChild(el);
        }
        return el;
    }

    function applyLayout() {
        styleTag(LAYOUT_ID).textContent = buildLayoutCSS(layout);
        for (const slot of SLOTS) html.dataset[`henge${slot[0].toUpperCase()}${slot.slice(1)}`] = layout[slot];
        syncViews();
    }

    function injectStyle() {
        styleTag(STYLE_ID).textContent = CSS;
        applyLayout();
    }

    function removeStyle() {
        document.getElementById(STYLE_ID)?.remove();
        document.getElementById(LAYOUT_ID)?.remove();
        for (const slot of SLOTS) delete html.dataset[`henge${slot[0].toUpperCase()}${slot.slice(1)}`];
    }

    function isOn() {
        return html.classList.contains(ROOT_CLASS);
    }

    // ── Self-check ────────────────────────────────────────────────────────────
    // After switching on or changing the layout, make sure the panels that
    // matter are visible and inside the window.

    function checkLayout() {
        const vw = window.innerWidth, vh = window.innerHeight;
        // [element, min width, min height]. The library can legitimately
        // collapse to an icon strip, hence its low minimum width; it's only
        // checked when it's placed.
        const targets = {
            'main view': [document.getElementById('main-view'), MIN_COLUMN, MIN_BOTTOM],
            'now-playing bar': [document.querySelector('.main-nowPlayingBar-nowPlayingBar'), 200, 40],
        };
        if (slotOf(layout, 'library')) targets.library = [document.getElementById(LEFT_ID), 40, 80];
        for (const [name, [el, minW, minH]] of Object.entries(targets)) {
            if (!el) continue; // not rendered (yet) — nothing to judge
            const r = el.getBoundingClientRect();
            if (r.width < minW || r.height < minH) return `${name} is too small`;
            if (r.right > vw + 2 || r.bottom > vh + 2 || r.left < -2 || r.top < -2) {
                return `${name} is off screen`;
            }
        }
        return null;
    }

    // onFail defaults to switching Henge off; a layout change passes its own
    // (put the previous layout back) so a bad pick can't stick.
    function selfCheck(onFail) {
        // Two frames: let the grid settle before measuring.
        requestAnimationFrame(() => requestAnimationFrame(() => {
            if (!isOn()) return;
            let problem;
            try { problem = checkLayout(); } catch (e) { problem = e.message; }
            if (!problem) return;
            warn('self-check failed:', problem);
            if (onFail) {
                onFail(problem);
            } else {
                disable(true);
                notify(`Henge switched itself off: ${problem}. Ctrl+Alt+H to retry.`, true);
            }
        }));
    }

    // ── Layout changes ────────────────────────────────────────────────────────

    function setLayout(next) {
        if (!validLayout(next)) return;
        const prev = layout;
        layout = next;
        lsSet(LS_LAYOUT, JSON.stringify(layout));
        if (!isOn()) return;
        applyLayout();
        applySizes();
        selfCheck(problem => {
            layout = prev;
            lsSet(LS_LAYOUT, JSON.stringify(layout));
            applyLayout();
            applySizes();
            renderPicker();
            notify(`Henge put the previous layout back: ${problem}`, true);
        });
    }

    // ── Layout picker (top bar button + popover) ──────────────────────────────

    // 24px outline, matching the custom-app icons beside it (Marketplace's
    // cart etc.): a lintel over two equal squares, 2px gaps, 2px stroke.
    const LAYOUT_ICON = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round">
<rect x="3" y="3" width="18" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>`;

    // The popover closes by itself this long after the pointer leaves it
    // (moving back in cancels). Paused while one of its dropdowns is open,
    // since the open list can hang outside the popover.
    const PICKER_LINGER_MS = 2500;

    let picker = null;   // the open popover, or null
    let anchorEl = null; // the top bar button's element
    let pointerInside = false;
    let choosing = false;
    let lingerTimer = null;

    function armAutoClose() {
        clearTimeout(lingerTimer);
        if (!picker || pointerInside || choosing) return;
        lingerTimer = setTimeout(closePicker, PICKER_LINGER_MS);
    }

    function slotSelect(slot) {
        const select = document.createElement('select');
        select.setAttribute('aria-label', `${SLOT_LABEL[slot]} panel`);
        const holdsMain = layout[slot] === 'main';
        const groups = {};
        for (const [src, def] of Object.entries(SOURCES)) {
            const opt = document.createElement('option');
            opt.value = src;
            opt.textContent = def.label;
            opt.selected = layout[slot] === src;
            // The main view needs a home: from its slot you can only swap it
            // with something already placed elsewhere.
            if (holdsMain && src !== 'main' && (src === 'none' || !slotOf(layout, src))) opt.disabled = true;
            if (def.group) {
                groups[def.group] ??= Object.assign(document.createElement('optgroup'), { label: def.group });
                groups[def.group].append(opt);
            } else {
                select.append(opt);
            }
        }
        select.prepend(...Object.values(groups));
        return pickerSelect(select, value => setLayout(withSource(layout, slot, value)));
    }

    // A picker dropdown: auto-close waits while its list is open.
    function pickerSelect(select, onChange) {
        select.addEventListener('mousedown', () => { choosing = true; clearTimeout(lingerTimer); });
        select.addEventListener('blur', () => { choosing = false; armAutoClose(); });
        select.addEventListener('change', () => {
            choosing = false;
            onChange(select.value);
            renderPicker();
            armAutoClose();
        });
        return select;
    }

    // Shown while the visualiser is placed.
    function visualiserRow(label, options, current, onChange) {
        const row = document.createElement('label');
        row.className = 'henge-picker-row';
        const name = document.createElement('span');
        name.textContent = label;
        const select = document.createElement('select');
        for (const [value, text] of Object.entries(options)) {
            select.append(Object.assign(document.createElement('option'), {
                value, textContent: text, selected: value === current,
            }));
        }
        row.append(name, pickerSelect(select, onChange));
        return row;
    }

    function renderPicker() {
        if (!picker) return;
        picker.replaceChildren();

        const title = document.createElement('h2');
        title.textContent = 'Henge layout';
        picker.append(title);

        if (!isOn()) {
            const note = document.createElement('p');
            note.className = 'henge-off-note';
            note.textContent = 'Henge is off — Ctrl+Alt+H switches it on. Changes here apply when it is.';
            picker.append(note);
        }

        const map = document.createElement('div');
        map.className = 'henge-map';
        for (const slot of SLOTS) {
            const box = document.createElement('label');
            box.className = `henge-slot henge-slot--${slot}`;
            const name = document.createElement('span');
            name.textContent = SLOT_LABEL[slot];
            box.append(name, slotSelect(slot));
            map.append(box);
        }
        picker.append(map);
        if (slotOf(layout, 'visualiser')) {
            picker.append(
                visualiserRow('Visualiser', VIS_STYLES, visualiser.style, v => visualiser.setStyle(v)),
                visualiserRow('Colours', VIS_COLOURS, visualiser.colours, v => visualiser.setColours(v)));
        }

        const foot = document.createElement('div');
        foot.className = 'henge-picker-foot';
        const hint = document.createElement('span');
        hint.textContent = 'Picking a placed item swaps it.';
        const reset = document.createElement('button');
        reset.textContent = 'Reset';
        reset.addEventListener('click', () => {
            setLayout({ ...DEFAULT_LAYOUT });
            renderPicker();
        });
        foot.append(hint, reset);
        picker.append(foot);

        // Henge.recon() without DevTools: Spotify resets the DevTools flag in
        // offline.bnk whenever it refreshes account data.
        const diag = document.createElement('div');
        diag.className = 'henge-picker-foot';
        const copy = document.createElement('button');
        copy.textContent = 'Copy diagnostics';
        copy.addEventListener('click', () => {
            try {
                recon();
                notify('Henge diagnostics copied to the clipboard');
            } catch (e) {
                notify(`Couldn't copy diagnostics: ${e.message}`, true);
            }
        });
        const ver = document.createElement('span');
        ver.textContent = `v${VERSION}`;
        diag.append(copy, ver);
        picker.append(diag);
    }

    function positionPicker() {
        if (!picker || !anchorEl) return;
        const r = anchorEl.getBoundingClientRect();
        const w = picker.offsetWidth;
        picker.style.top = `${Math.round(r.bottom + 8)}px`;
        picker.style.left = `${Math.round(clamp(r.left, 8, window.innerWidth - w - 8))}px`;
    }

    function closePicker() {
        clearTimeout(lingerTimer);
        pointerInside = false;
        choosing = false;
        picker?.remove();
        picker = null;
        document.removeEventListener('pointerdown', onOutside, true);
        document.removeEventListener('keydown', onPickerKey, true);
    }

    function onOutside(e) {
        if (picker && !picker.contains(e.target) && !anchorEl?.contains(e.target)) closePicker();
    }

    function onPickerKey(e) {
        if (e.key === 'Escape') { e.stopPropagation(); closePicker(); }
    }

    function openPicker() {
        picker = document.createElement('div');
        picker.id = 'henge-picker';
        picker.setAttribute('role', 'dialog');
        picker.setAttribute('aria-label', 'Henge layout');
        // Same rule from the start: opened and never visited, it closes too.
        picker.addEventListener('pointerenter', () => { pointerInside = true; clearTimeout(lingerTimer); });
        picker.addEventListener('pointerleave', () => { pointerInside = false; armAutoClose(); });
        document.body.append(picker);
        renderPicker();
        positionPicker();
        document.addEventListener('pointerdown', onOutside, true);
        document.addEventListener('keydown', onPickerKey, true);
        armAutoClose();
    }

    // Picker and button CSS, needed from the start for the icon size.
    styleTag(UI_ID).textContent = UI_CSS;

    const layoutButton = new Spicetify.Topbar.Button('Henge layout', LAYOUT_ICON, () => {
        if (picker) closePicker(); else openPicker();
    });
    anchorEl = layoutButton.element;

    // ── On / off ──────────────────────────────────────────────────────────────

    function enable(persist = true) {
        try {
            injectStyle();
            html.classList.add(ROOT_CLASS);
            hooked = { root: null, left: null }; // force a fresh hook
            hook();
            syncViews();
            updateState();
            if (persist) writeEnabled(true);
            selfCheck();
        } catch (e) {
            warn('enable failed, reverting:', e);
            disable(true);
        }
        renderPicker();
    }

    function disable(persist = true) {
        html.classList.remove(ROOT_CLASS, 'henge-lib-collapsed', 'henge-lib-expanded', 'henge-resizing');
        observer.disconnect();
        for (const el of [rowHandle, colHandle, panelPlaceholder]) el.remove();
        syncViews(); // off: unmounts every pinned panel
        removeStyle();
        if (persist) writeEnabled(false);
        renderPicker();
    }

    function toggle() {
        if (isOn()) {
            disable();
            notify('Henge off');
        } else {
            enable();
            notify('Henge on');
        }
    }

    window.addEventListener('keydown', e => {
        if (e.repeat || !e.ctrlKey || !e.altKey || e.shiftKey || e.metaKey) return;
        if (e.code !== 'KeyH') return;
        e.preventDefault();
        e.stopPropagation();
        toggle();
    }, true);

    // ── DevTools helpers ──────────────────────────────────────────────────────

    function copyOut(label, data) {
        const json = JSON.stringify(data, null, 2);
        try {
            Spicetify.Platform.ClipboardAPI.copy(json);
            log(`${label} copied to clipboard`);
        } catch {
            log(`${label} (copy this):\n` + json);
        }
        return data;
    }

    const attrsOf = el => Object.fromEntries([...el.attributes].map(a => [a.name, a.value]));

    function describe(el) {
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        const data = {};
        for (const a of el.attributes) {
            if (a.name.startsWith('data-') || a.name === 'id' || a.name === 'aria-label') {
                data[a.name] = a.value;
            }
        }
        return {
            tag: el.tagName.toLowerCase(),
            className: typeof el.className === 'string' ? el.className : '',
            attrs: data,
            gridArea: cs.gridArea,
            display: cs.display,
            visibility: cs.visibility,
            rect: [r.left, r.top, r.width, r.height].map(Math.round),
        };
    }

    // Elements inside a pinned panel that scroll, or are taller than the
    // panel: where its height goes, for diagnosing clipped scrolling.
    function scrollersIn(root) {
        const limit = root.getBoundingClientRect().height + 2;
        const out = [];
        for (const el of root.querySelectorAll('*')) {
            const cs = getComputedStyle(el);
            const scrolls = /auto|scroll/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1;
            const tall = el.getBoundingClientRect().height > limit;
            if (!scrolls && !tall) continue;
            out.push({
                className: (typeof el.className === 'string' ? el.className : '').slice(0, 60),
                overflowY: cs.overflowY,
                height: cs.height,
                clientHeight: el.clientHeight,
                scrollHeight: el.scrollHeight,
                tall,
            });
            if (out.length >= 8) break;
        }
        return out;
    }

    // Henge.recon(): the root grid and its children, so the layout can be
    // written against the real DOM. Copies JSON to the clipboard.
    function recon() {
        const root = getRoot();
        const cs = getComputedStyle(root);
        const left = document.getElementById(LEFT_ID);
        return copyOut('recon', {
            henge: VERSION,
            spicetify: Spicetify.Config?.version,
            spotify: Spicetify.Platform?.version,
            window: [window.innerWidth, window.innerHeight],
            henge_on: isOn(),
            layout,
            state: {
                collapsed: html.classList.contains('henge-lib-collapsed'),
                expanded: html.classList.contains('henge-lib-expanded'),
                sidePanelOpen: !!document.getElementById('Desktop_PanelContainer_Id'),
                nativeLibraryWidth: left && getComputedStyle(left).getPropertyValue('--left-sidebar-width').trim(),
                saved: { bottom: lsGet(LS_BOTTOM), column: lsGet(LS_COLUMN) },
                rootStyle: root.getAttribute('style'),
            },
            html: attrsOf(html),
            root: {
                gridTemplateAreas: cs.gridTemplateAreas,
                gridTemplateColumns: cs.gridTemplateColumns,
                gridTemplateRows: cs.gridTemplateRows,
            },
            children: [...root.children].map(describe),
            pinned: Object.fromEntries([...views].map(([kind, v]) => [kind, {
                captured: !!captured[kind],
                error: v.error,
                providers: captured[kind]?.providers.length ?? null,
                ownScrollNode: !!captured[kind]?.ownScrollNode,
                scrollContextFound: !!v.scrollCtx,
                lastChanged: v.lastChanged ?? [],
                viewHeight: Math.round(v.el.getBoundingClientRect().height),
                scrollers: scrollersIn(v.el),
            }])),
            visualiser: visualiser.info(),
        });
    }

    // Shape of a value, for API probing: keys and types, first array element.
    function shape(v, depth = 3) {
        if (v == null || typeof v !== 'object') {
            return typeof v === 'string' ? `string(${v.slice(0, 60)})` : v === null ? null : typeof v;
        }
        if (depth === 0) return Array.isArray(v) ? `array(${v.length})` : 'object';
        if (Array.isArray(v)) return { length: v.length, first: v.length ? shape(v[0], depth - 1) : null };
        return Object.fromEntries(Object.keys(v).slice(0, 40).map(k => [k, shape(v[k], depth - 1)]));
    }

    // Henge.probe(): checks the APIs the Now Playing / Queue / Lyrics views
    // will use, and which of Spotify's panel buttons exist. Play a track with
    // lyrics and a few queued songs first.
    async function probe() {
        const P = Spicetify.Platform?.PlayerAPI;
        const out = { henge: VERSION };

        out.playerApi = P ? {
            methods: Object.getOwnPropertyNames(Object.getPrototypeOf(P)),
            props: Object.keys(P),
            events: P._events ? Object.keys(P._events._listeners ?? P._events) : null,
            state: shape(P._state, 2),
        } : null;
        try { out.queue = shape(await P.getQueue(), 4); } catch (e) { out.queueError = String(e); }
        out.spicetifyQueue = Spicetify.Queue ? shape(Spicetify.Queue, 3) : null;
        out.playerData = shape(Spicetify.Player?.data, 3);

        const uri = Spicetify.Player?.data?.item?.uri ?? '';
        const id = uri.startsWith('spotify:track:') ? uri.split(':')[2] : null;
        if (id) {
            try {
                const r = await Spicetify.CosmosAsync.get(
                    `https://spclient.wg.spotify.com/color-lyrics/v2/track/${id}?format=json&vocalRemoval=false&market=from_token`);
                out.lyrics = {
                    shape: shape(r, 2),
                    syncType: r?.lyrics?.syncType,
                    lines: r?.lyrics?.lines?.length,
                    firstLines: r?.lyrics?.lines?.slice(0, 3),
                };
            } catch (e) { out.lyricsError = String(e); }
        } else {
            out.lyricsError = `not a track: ${uri}`;
        }

        out.panelControls = Object.fromEntries(Object.entries(PANEL_CONTROLS).map(
            ([name, sels]) => [name, sels.map(s => [s, !!document.querySelector(s)])]));
        const buttons = sel => [...document.querySelectorAll(`${sel} button`)].map(b => ({
            label: b.getAttribute('aria-label'), testid: b.dataset.testid ?? null,
        })).filter(b => b.label || b.testid);
        out.buttons = {
            nowPlayingBar: buttons('.main-nowPlayingBar-right'),
            globalNav: buttons('#global-nav-bar'),
        };
        return copyOut('probe', out);
    }

    // ── Spike: a second live copy of a Spotify view ───────────────────────────
    // Experiment harness (2026-10-04) that proved pinned panels possible; kept
    // for trying new sources, e.g. a page from the main view such as lyrics.
    // Renders a component from the live tree a second time, in a floating box,
    // with every context provider above it.
    //   Henge.spike()              side panel, candidate 0 (outermost component)
    //   Henge.spike(n)             side panel, candidate n from the report
    //   Henge.spike(n, 'main')     main view instead of the side panel
    //   Henge.spikeClose()         close every spike box

    function spikeBoundary() {
        const R = Spicetify.React;
        return class HengeSpikeBoundary extends R.Component {
            constructor(props) { super(props); this.state = { error: null }; }
            static getDerivedStateFromError(error) { return { error }; }
            componentDidCatch(error) { warn('spike render error:', error); }
            render() {
                if (!this.state.error) return this.props.children;
                return R.createElement('pre', {
                    style: { margin: 0, padding: 12, whiteSpace: 'pre-wrap', fontSize: 12, color: 'var(--text-subdued, #b3b3b3)' },
                }, String(this.state.error?.stack || this.state.error));
            }
        };
    }

    const spikes = [];

    function spikeBox(title, asideClass) {
        const n = spikes.length;
        const box = document.createElement('div');
        Object.assign(box.style, {
            position: 'fixed', top: `${80 + n * 30}px`, right: `${20 + n * 30}px`,
            width: '420px', height: '65vh', zIndex: 9998, display: 'flex', flexDirection: 'column',
            borderRadius: '8px', overflow: 'hidden', resize: 'both',
            background: 'var(--background-base, #121212)', boxShadow: '0 16px 24px rgba(0,0,0,.5)',
            outline: '2px dashed var(--essential-subdued, #727272)',
        });
        const bar = document.createElement('div');
        Object.assign(bar.style, {
            display: 'flex', justifyContent: 'space-between', alignItems: 'center', flex: '0 0 auto',
            padding: '6px 10px', fontSize: '12px', color: 'var(--text-subdued, #b3b3b3)',
            background: 'var(--background-elevated-base, #282828)',
        });
        bar.append(`Henge spike — ${title}`);
        const close = document.createElement('button');
        close.textContent = '×';
        Object.assign(close.style, { background: 'none', border: 0, color: 'inherit', fontSize: '18px', cursor: 'pointer' });
        bar.append(close);
        const content = document.createElement('div');
        content.className = asideClass; // Spotify's own panel container styling
        Object.assign(content.style, { flex: '1 1 auto', minHeight: 0, height: 'auto', position: 'relative' });
        box.append(bar, content);
        document.body.append(box);
        return { box, content, close };
    }

    function spike(index = 0, from = 'panel') {
        const R = Spicetify.React;
        const report = { henge: VERSION, react: R?.version ?? null, from };
        const done = () => copyOut('spike', report);

        const anchor = from === 'main'
            ? document.querySelector('#main-view .main-view-container') ?? document.getElementById('main-view')
            : document.getElementById(ASIDE_ID);
        if (!anchor) { report.error = from === 'main' ? 'No main view found.' : 'Open the side panel first.'; return done(); }
        const fiber = fiberOf(anchor);
        if (!fiber) { report.error = 'No React fibre on that element.'; return done(); }
        report.location = location.pathname;

        // The main view's page sits deeper, so look further down.
        const candidates = from === 'main'
            ? componentsUnder(currentPath(fiber)?.[0] ?? fiber, 40, 40)
            : componentsUnder(currentPath(fiber)?.[0] ?? fiber);
        report.candidates = candidates.map((c, i) => ({
            i, depth: c.depth, tag: c.fiber.tag, name: fiberName(c.fiber),
            props: Object.keys(c.fiber.memoizedProps ?? {}),
        }));
        const pick = candidates[index];
        if (!pick) { report.error = `No candidate ${index}.`; return done(); }

        const createRoot = getCreateRoot();
        report.createRoot = !!createRoot;
        if (!createRoot) { report.error = 'Could not find ReactDOM createRoot.'; return done(); }

        const providers = providersAbove(pick.fiber.return);
        report.providers = providers.length;

        let el = R.createElement(pick.fiber.elementType ?? pick.fiber.type, { ...pick.fiber.memoizedProps });
        for (const p of providers) el = R.createElement(p.type, { value: p.value }, el);

        const name = fiberName(pick.fiber);
        const { box, content, close } = spikeBox(`#${index} ${name}`, from === 'main' ? '' : anchor.className);
        try {
            const root = createRoot(content);
            root.render(R.createElement(spikeBoundary(), null, el));
            const entry = { box, root };
            close.addEventListener('click', () => {
                try { root.unmount(); } catch {}
                box.remove();
                spikes.splice(spikes.indexOf(entry), 1);
            });
            spikes.push(entry);
            report.rendered = { index, name };
        } catch (e) {
            report.error = `render threw: ${e?.message ?? e}`;
            box.remove();
        }
        return done();
    }

    function spikeClose() {
        for (const { box, root } of spikes.splice(0)) {
            try { root.unmount(); } catch {}
            box.remove();
        }
    }

    window.Henge = {
        version: VERSION, enable, disable, toggle, recon, probe, spike, spikeClose,
        get layout() { return { ...layout }; },
    };

    // ── Start ─────────────────────────────────────────────────────────────────

    try {
        if (readEnabled()) enable(false);
        log(`v${VERSION} loaded — ${isOn() ? 'on' : 'off'} (Ctrl+Alt+H toggles)`, layout);
    } catch (e) {
        warn('startup failed, reverting:', e);
        disable(false);
    }
})();
