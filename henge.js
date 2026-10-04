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
    const VERSION = '0.3.1';

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
    const SOURCES = {
        main:    { label: 'Main view',  group: 'Spotify', sel: '#main-view',  child: '#main-view' },
        library: { label: 'Library',    group: 'Spotify', sel: `#${LEFT_ID}`, child: `#${LEFT_ID}` },
        panel:   { label: 'Side panel', group: 'Spotify', sel: RIGHT,         child: null },
        none:    { label: 'Nothing',    group: null },
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
#henge-panel-placeholder .henge-ph-buttons {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 8px;
}
#henge-panel-placeholder button {
    padding: 6px 14px;
    border: 1px solid var(--essential-subdued, #727272);
    border-radius: 999px;
    background: none;
    color: var(--text-base, #fff);
    font: inherit;
    cursor: pointer;
}
#henge-panel-placeholder button:hover {
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

        // Place, or hide, each Spotify source. Hidden ones stay mounted.
        for (const src of ['main', 'library', 'panel']) {
            const slot = slotOf(l, src);
            add(`${H} ${SOURCES[src].sel}`, slot
                ? `grid-area: ${AREA[slot]} !important;`
                : 'display: none !important;');
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
            if (el) { el.click(); return; }
        }
        notify(`Couldn't find Spotify's ${name} button`, true);
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
        for (const el of [rowHandle, colHandle, panelPlaceholder]) {
            if (el.parentElement !== root) root.appendChild(el);
        }
    }

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

    const LAYOUT_ICON = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
<rect x="1.5" y="1.5" width="13" height="6.5" rx="1"/><rect x="1.5" y="9.5" width="6" height="5" rx="1"/><rect x="9" y="9.5" width="5.5" height="5" rx="1"/></svg>`;

    let picker = null;   // the open popover, or null
    let anchorEl = null; // the top bar button's element

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
        select.addEventListener('change', () => {
            setLayout(withSource(layout, slot, select.value));
            renderPicker();
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
    }

    function positionPicker() {
        if (!picker || !anchorEl) return;
        const r = anchorEl.getBoundingClientRect();
        const w = picker.offsetWidth;
        picker.style.top = `${Math.round(r.bottom + 8)}px`;
        picker.style.left = `${Math.round(clamp(r.left, 8, window.innerWidth - w - 8))}px`;
    }

    function closePicker() {
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
        styleTag(UI_ID).textContent = UI_CSS;
        picker = document.createElement('div');
        picker.id = 'henge-picker';
        picker.setAttribute('role', 'dialog');
        picker.setAttribute('aria-label', 'Henge layout');
        document.body.append(picker);
        renderPicker();
        positionPicker();
        document.addEventListener('pointerdown', onOutside, true);
        document.addEventListener('keydown', onPickerKey, true);
    }

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

    // ── Spike: a second live copy of Spotify's side panel ─────────────────────
    // Experiment (2026-10-04): can Spotify's own panel components run twice?
    // Henge.spike() takes whatever the side panel shows right now — its React
    // component, props, and every context provider above it — and renders a
    // second copy in a floating box. Then switch the real side panel to
    // something else and see whether the copy stays alive and interactive.
    //   Henge.spike()        render candidate 0 (the outermost panel component)
    //   Henge.spike(n)       render candidate n from the report instead
    //   Henge.spikeClose()   close every spike box

    const COMPOSITE_TAGS = new Set([0, 1, 11, 14, 15]); // function, class, forwardRef, memo, simple memo
    const PROVIDER_TAG = 10;

    function fiberOf(el) {
        const key = el && Object.keys(el).find(k => k.startsWith('__reactFiber$'));
        return key ? el[key] : null;
    }

    function fiberName(f) {
        const t = f.elementType ?? f.type;
        return t?.displayName || t?.name || t?.render?.displayName || t?.render?.name
            || t?.type?.displayName || t?.type?.name || `(anonymous, tag ${f.tag})`;
    }

    // Composite (component) fibers under the aside, depth-first, outermost first.
    function panelCandidates(asideFiber, limit = 12) {
        const out = [];
        const stack = [[asideFiber.child, 0]];
        while (stack.length && out.length < limit) {
            const [f, depth] = stack.pop();
            if (!f) continue;
            if (COMPOSITE_TAGS.has(f.tag)) out.push({ fiber: f, depth });
            if (f.sibling) stack.push([f.sibling, depth]);
            if (f.child && depth < 8) stack.push([f.child, depth + 1]);
        }
        return out;
    }

    // Context providers from a fibre up to the root, innermost first. The
    // provider's fibre type renders as the provider in React 18 and 19 alike.
    function providersAbove(fiber) {
        const list = [];
        for (let f = fiber; f; f = f.return) {
            if (f.tag === PROVIDER_TAG) list.push({ type: f.type, value: f.memoizedProps?.value });
        }
        return list;
    }

    // Spicetify.ReactDOM is the module with createPortal; createRoot may live
    // in react-dom/client. Look in webpack's cache of already-loaded modules
    // only, so nothing new gets executed.
    function findCreateRoot() {
        if (typeof Spicetify.ReactDOM?.createRoot === 'function') return Spicetify.ReactDOM.createRoot;
        let req = null;
        try { window.webpackChunkclient_web.push([[Symbol('henge')], {}, r => { req = r; }]); } catch {}
        for (const mod of Object.values(req?.c ?? {})) {
            const ex = mod?.exports;
            if (ex && typeof ex.createRoot === 'function' && typeof ex.hydrateRoot === 'function') return ex.createRoot;
        }
        return null;
    }

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

    function spike(index = 0) {
        const R = Spicetify.React;
        const report = { henge: VERSION, react: R?.version ?? null };
        const done = () => copyOut('spike', report);

        const aside = document.getElementById('Desktop_PanelContainer_Id');
        if (!aside) { report.error = 'Open the side panel first (Queue or Now Playing).'; return done(); }
        const asideFiber = fiberOf(aside);
        if (!asideFiber) { report.error = 'No React fibre on the side panel element.'; return done(); }

        const candidates = panelCandidates(asideFiber);
        report.candidates = candidates.map((c, i) => ({
            i, depth: c.depth, tag: c.fiber.tag, name: fiberName(c.fiber),
            props: Object.keys(c.fiber.memoizedProps ?? {}),
        }));
        const pick = candidates[index];
        if (!pick) { report.error = `No candidate ${index}.`; return done(); }

        const createRoot = findCreateRoot();
        report.createRoot = !!createRoot;
        if (!createRoot) { report.error = 'Could not find ReactDOM createRoot.'; return done(); }

        const providers = providersAbove(pick.fiber.return);
        report.providers = providers.length;

        let el = R.createElement(pick.fiber.elementType ?? pick.fiber.type, { ...pick.fiber.memoizedProps });
        for (const p of providers) el = R.createElement(p.type, { value: p.value }, el);

        const name = fiberName(pick.fiber);
        const { box, content, close } = spikeBox(`#${index} ${name}`, aside.className);
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
