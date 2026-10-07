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
    const VERSION = '1.0.2';

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
        none:       { label: 'Nothing',         group: null },
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
        loadView(kind);
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
        select.addEventListener('mousedown', () => { choosing = true; clearTimeout(lingerTimer); });
        select.addEventListener('blur', () => { choosing = false; armAutoClose(); });
        select.addEventListener('change', () => {
            choosing = false;
            setLayout(withSource(layout, slot, select.value));
            renderPicker();
            armAutoClose();
        });
        return select;
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
