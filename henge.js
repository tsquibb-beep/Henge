// Spicetify Extension: Henge — stacked Spotify layout
// ─────────────────────────────────────────────────────
// Main view spans the full width; Library and the right panel sit below it,
// side by side. Drag the handles between panels to resize; double-click a
// handle to reset it.
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
    const VERSION = '0.2.0';

    const LS_ENABLED = 'henge:enabled';
    const LS_BOTTOM  = 'henge:bottomHeight';   // px, bottom row height
    const LS_LIBRARY = 'henge:libraryWidth';   // px, library width in the bottom row

    const ROOT_CLASS = 'henge-on';
    const STYLE_ID   = 'henge-style';
    const ROOT_SEL   = '.Root__top-container';
    const LEFT_ID    = 'Desktop_LeftSidebar_Id';

    // Size limits (px) the handles clamp to.
    const MIN_MAIN    = 200;
    const MIN_BOTTOM  = 150;
    const MIN_LIBRARY = 200;
    const MIN_RIGHT   = 280;
    // Spotify's collapsed (icon-strip) library is ~72px wide; anything at or
    // under this is treated as collapsed and left to Spotify to size.
    const COLLAPSED_MAX = 120;

    const html = document.documentElement;
    const log  = (...a) => console.log('[Henge]', ...a);
    const warn = (...a) => console.warn('[Henge]', ...a);
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    while (!Spicetify?.showNotification || !document.querySelector(ROOT_SEL)) {
        await sleep(100);
    }

    // ── Layout CSS ────────────────────────────────────────────────────────────
    // Every rule is scoped under html.henge-on, so removing that one class
    // restores Spotify's native layout.
    //
    // Grid items (from Henge.recon() on 1.3.3): #Desktop_LeftSidebar_Id,
    // #main-view, the right panel (the child holding #Desktop_PanelContainer_Id),
    // the now-playing bar, #global-nav-bar, plus overlays that span named lines.
    // The library's previous sibling is a placeholder Spotify shows only in
    // expanded-library mode (it holds the library's column open).
    //
    // State classes on <html>, kept current by updateState():
    //   henge-lib-collapsed — library is Spotify's icon strip
    //   henge-lib-expanded  — "Expand Your Library" mode
    //   henge-resizing      — a Henge handle is being dragged

    const RIGHT       = '.Root__top-container > :has(#Desktop_PanelContainer_Id)';
    const NO_RIGHT    = '.Root__top-container:not(:has(#Desktop_PanelContainer_Id))';
    const PLACEHOLDER = `.Root__top-container > :has(+ #${LEFT_ID})`;

    const CSS = `
html.henge-on .Root__top-container {
    grid-template:
        "top-banner top-banner"
        "global-nav global-nav"
        "main-view main-view" minmax(0, 1fr)
        "left-sidebar right-sidebar" var(--henge-bottom-h, 40%)
        "now-playing-bar now-playing-bar"
        / auto minmax(0, 1fr) !important;
}

/* ── Library ── */

/* Henge owns the library width (Spotify caps its own at a fixed pixel size).
   Collapsed keeps Spotify's icon-strip width. */
html.henge-on:not(.henge-lib-collapsed) #${LEFT_ID} {
    width: var(--henge-left-w, calc(var(--left-sidebar-width) * 1px)) !important;
}
/* ...so Spotify's own library resizer is replaced by Henge's column handle,
   except when collapsed, where dragging it out is how you expand. */
html.henge-on:not(.henge-lib-collapsed) #${LEFT_ID} > .LayoutResizer__resize-bar {
    display: none !important;
}

/* Right panel closed: the library takes the whole bottom row. */
html.henge-on:not(.henge-lib-collapsed) ${NO_RIGHT} > #${LEFT_ID} {
    grid-column: 1 / -1 !important;
    width: auto !important;
}

/* Expanded library: natively it takes over the main view, so stacked it
   takes the main-view area and the right panel gets the whole bottom row. */
html.henge-on.henge-lib-expanded #${LEFT_ID} {
    grid-area: main-view !important;
    width: auto !important;
}
html.henge-on.henge-lib-expanded ${RIGHT} {
    grid-column: 1 / -1 !important;
}
/* Expanded with the right panel closed: the library takes both rows. */
html.henge-on.henge-lib-expanded ${NO_RIGHT} > #${LEFT_ID} {
    grid-area: main-view-start / 1 / left-sidebar-end / -1 !important;
}
/* The expanded-mode placeholder would hold an empty column open. Taken out of
   flow rather than display:none, because updateState() reads its display. */
html.henge-on ${PLACEHOLDER} {
    position: absolute !important;
    visibility: hidden !important;
    pointer-events: none !important;
}

/* ── Right panel: fill whatever the library leaves ── */

html.henge-on ${RIGHT} {
    width: auto !important;
    min-width: 0 !important;
}
html.henge-on ${RIGHT} > :not(.LayoutResizer__resize-bar) {
    flex: 1 1 auto !important;
    width: auto !important;
    min-width: 0 !important;
    max-width: none !important;
}
html.henge-on #Desktop_PanelContainer_Id {
    width: 100% !important;
    max-width: none !important;
}
/* Its own resizer sits on the library boundary; Henge's column handle does
   that job now. */
html.henge-on ${RIGHT} > .LayoutResizer__resize-bar {
    display: none !important;
}

/* ── Overlays ── */

/* Lyrics cinema natively spans from the library's right edge to the window's.
   Stacked, that becomes the whole area above the bottom row. */
html.henge-on .Root__lyrics-cinema {
    grid-area: 1 / 1 / left-sidebar-start / -1 !important;
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

/* Between the main view and the bottom row, in the panel gap. */
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

/* Between the library and the right panel, in the panel gap. */
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

/* No library/right-panel boundary to drag in these states. */
html.henge-on.henge-lib-collapsed #henge-col-handle,
html.henge-on.henge-lib-expanded #henge-col-handle,
html.henge-on ${NO_RIGHT} > #henge-col-handle,
html.henge-on.henge-lib-expanded ${NO_RIGHT} > #henge-row-handle {
    display: none;
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

    // Main + bottom rows together: the height the row handle shares out.
    function stackHeight() {
        const rows = tracks('gridTemplateRows');
        return rows.length >= 5 ? rows[2] + rows[3] : null;
    }

    // Library + right panel columns together: the width the column handle shares.
    function bottomWidth() {
        const cols = tracks('gridTemplateColumns');
        return cols.length >= 2 ? cols[0] + cols[1] : null;
    }

    const hasRightPanel = () => !!document.getElementById('Desktop_PanelContainer_Id');

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
        setVar('--henge-bottom-h', total ? clamp(pref, MIN_BOTTOM, total - MIN_MAIN) : pref);
    }

    function applyLibrary(pref = lsNumber(LS_LIBRARY)) {
        if (pref == null) return setVar('--henge-left-w', null);
        const total = hasRightPanel() ? bottomWidth() : null;
        setVar('--henge-left-w', total ? clamp(pref, MIN_LIBRARY, total - MIN_RIGHT) : pref);
    }

    function applySizes() {
        applyBottom();
        applyLibrary();
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

    const rowHandle = makeHandle('henge-row-handle', 'Resize main view and bottom panels', {
        start(e) {
            const rows = tracks('gridTemplateRows');
            if (rows.length < 5) return null;
            const ctx = { y: e.clientY, bottom: rows[3], total: rows[2] + rows[3], value: rows[3] };
            ctx.save = () => lsSet(LS_BOTTOM, Math.round(ctx.value));
            return ctx;
        },
        move(ctx, e) {
            ctx.value = clamp(ctx.bottom - (e.clientY - ctx.y), MIN_BOTTOM, ctx.total - MIN_MAIN);
            setVar('--henge-bottom-h', ctx.value);
        },
        reset() {
            lsSet(LS_BOTTOM, null);
            applyBottom();
        },
    });

    const colHandle = makeHandle('henge-col-handle', 'Resize library and right panel', {
        start(e) {
            const cols = tracks('gridTemplateColumns');
            if (cols.length < 2) return null;
            const ctx = { x: e.clientX, left: cols[0], total: cols[0] + cols[1], value: cols[0] };
            ctx.save = () => lsSet(LS_LIBRARY, Math.round(ctx.value));
            return ctx;
        },
        move(ctx, e) {
            ctx.value = clamp(ctx.left + (e.clientX - ctx.x), MIN_LIBRARY, ctx.total - MIN_RIGHT);
            setVar('--henge-left-w', ctx.value);
        },
        reset() {
            lsSet(LS_LIBRARY, null);
            applyLibrary();
        },
    });

    function ensureHandles(root) {
        if (rowHandle.parentElement !== root) root.appendChild(rowHandle);
        if (colHandle.parentElement !== root) root.appendChild(colHandle);
    }

    // ── Watching Spotify ──────────────────────────────────────────────────────
    // Targeted observers on the library (its class and inline width change with
    // collapse / expand) and the root's children. A slow poll re-hooks them if
    // React replaces the root or the library, and puts the handles back.

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
                if (!html.classList.contains('henge-resizing')) applyLibrary();
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
            ensureHandles(root);
        }
        if (left) observer.observe(left, { attributes: true, attributeFilter: ['class', 'style'] });
        const placeholder = left?.previousElementSibling;
        if (placeholder) observer.observe(placeholder, { attributes: true, attributeFilter: ['class', 'style'] });
        hooked = { root, left };
        applySizes();
        schedule();
    }

    setInterval(() => { if (isOn()) hook(); }, 1000);

    let resizePending = false;
    window.addEventListener('resize', () => {
        if (resizePending || !isOn()) return;
        resizePending = true;
        requestAnimationFrame(() => { resizePending = false; applySizes(); });
    });

    // ── Style + class ─────────────────────────────────────────────────────────

    function injectStyle() {
        let el = document.getElementById(STYLE_ID);
        if (!el) {
            el = document.createElement('style');
            el.id = STYLE_ID;
            document.head.appendChild(el);
        }
        el.textContent = CSS;
    }

    function removeStyle() {
        document.getElementById(STYLE_ID)?.remove();
    }

    function isOn() {
        return html.classList.contains(ROOT_CLASS);
    }

    // ── Self-check ────────────────────────────────────────────────────────────
    // After switching on, make sure the panels that matter are still visible
    // and inside the window. If not, the layout is broken: switch off.

    function checkLayout() {
        const vw = window.innerWidth, vh = window.innerHeight;
        // [element, min width, min height]. The library can legitimately
        // collapse to an icon strip, hence its low minimum width.
        const targets = {
            'main view': [document.getElementById('main-view'), 200, 150],
            'library': [document.getElementById(LEFT_ID), 40, 80],
            'now-playing bar': [document.querySelector('.main-nowPlayingBar-nowPlayingBar'), 200, 40],
        };
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

    function selfCheck() {
        // Two frames: let the grid settle before measuring.
        requestAnimationFrame(() => requestAnimationFrame(() => {
            if (!isOn()) return;
            let problem;
            try { problem = checkLayout(); } catch (e) { problem = e.message; }
            if (problem) {
                warn('self-check failed:', problem);
                disable(true);
                notify(`Henge switched itself off: ${problem}. Ctrl+Alt+H to retry.`, true);
            }
        }));
    }

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
    }

    function disable(persist = true) {
        html.classList.remove(ROOT_CLASS, 'henge-lib-collapsed', 'henge-lib-expanded', 'henge-resizing');
        observer.disconnect();
        rowHandle.remove();
        colHandle.remove();
        removeStyle();
        if (persist) writeEnabled(false);
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

    // ── Recon (DevTools helper) ───────────────────────────────────────────────
    // Henge.recon() dumps the root grid and its children so the layout can be
    // written against the real DOM. Copies JSON to the clipboard when it can.

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
            position: cs.position,
            width: cs.width,
            rect: [r.left, r.top, r.width, r.height].map(Math.round),
            hooks: {
                leftSidebar: !!el.querySelector(`#${LEFT_ID}`) || el.id === LEFT_ID,
                panelContainer: !!el.querySelector('#Desktop_PanelContainer_Id') || el.id === 'Desktop_PanelContainer_Id',
                mainView: !!el.querySelector('.main-view-container'),
                nowPlayingBar: !!el.querySelector('.main-nowPlayingBar-nowPlayingBar'),
                globalNav: el.matches('.Root__globalNav') || !!el.querySelector('.Root__globalNav'),
                resizers: [...el.querySelectorAll('.LayoutResizer__resize-bar')].map(b => {
                    const br = b.getBoundingClientRect();
                    return {
                        parentClass: b.parentElement?.className ?? '',
                        rect: [br.left, br.top, br.width, br.height].map(Math.round),
                    };
                }),
            },
        };
    }

    // The right panel from its grid item down to the <aside>, and two levels
    // into the aside: where its width comes from.
    function rightChain() {
        const aside = document.getElementById('Desktop_PanelContainer_Id');
        if (!aside) return null;
        const root = getRoot();
        const row = el => {
            const cs = getComputedStyle(el);
            return {
                tag: el.tagName.toLowerCase(),
                className: typeof el.className === 'string' ? el.className : '',
                style: el.getAttribute('style'),
                width: cs.width, minWidth: cs.minWidth, maxWidth: cs.maxWidth,
                display: cs.display, flex: cs.flex,
            };
        };
        const up = [];
        for (let el = aside; el && el !== root; el = el.parentElement) up.unshift(row(el));
        const down = [...aside.children].map(c => ({ ...row(c), children: [...c.children].map(row) }));
        return { up, down };
    }

    function recon() {
        const root = getRoot();
        const cs = getComputedStyle(root);
        const left = document.getElementById(LEFT_ID);
        const out = {
            henge: VERSION,
            spicetify: Spicetify.Config?.version,
            spotify: Spicetify.Platform?.version,
            window: [window.innerWidth, window.innerHeight],
            henge_on: isOn(),
            state: {
                collapsed: html.classList.contains('henge-lib-collapsed'),
                expanded: html.classList.contains('henge-lib-expanded'),
                nativeLibraryWidth: left && getComputedStyle(left).getPropertyValue('--left-sidebar-width').trim(),
                saved: { bottom: lsGet(LS_BOTTOM), library: lsGet(LS_LIBRARY) },
                rootStyle: root.getAttribute('style'),
            },
            html: attrsOf(html),
            body: attrsOf(document.body),
            root: {
                attrs: attrsOf(root),
                gridTemplateAreas: cs.gridTemplateAreas,
                gridTemplateColumns: cs.gridTemplateColumns,
                gridTemplateRows: cs.gridTemplateRows,
            },
            ancestors: (() => {
                const list = [];
                for (let el = root.parentElement; el && el !== document.body; el = el.parentElement) {
                    list.push({ tag: el.tagName.toLowerCase(), attrs: attrsOf(el) });
                }
                return list;
            })(),
            children: [...root.children].map(describe),
            rightChain: rightChain(),
        };
        const json = JSON.stringify(out, null, 2);
        try {
            Spicetify.Platform.ClipboardAPI.copy(json);
            log('recon copied to clipboard');
        } catch {
            log('recon (copy this):\n' + json);
        }
        return out;
    }

    window.Henge = { version: VERSION, enable, disable, toggle, recon };

    // ── Start ─────────────────────────────────────────────────────────────────

    try {
        if (readEnabled()) enable(false);
        log(`v${VERSION} loaded — ${isOn() ? 'on' : 'off'} (Ctrl+Alt+H toggles)`);
    } catch (e) {
        warn('startup failed, reverting:', e);
        disable(false);
    }
})();
