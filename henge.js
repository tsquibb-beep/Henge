// Spicetify Extension: Henge — stacked Spotify layout
// ─────────────────────────────────────────────────────
// Main view spans the full width; Library and the right panel sit below it,
// side by side. Drag the handles between panels to resize.
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
    const VERSION = '0.1.0';

    const LS_ENABLED = 'henge:enabled';
    const ROOT_CLASS = 'henge-on';
    const STYLE_ID   = 'henge-style';
    const ROOT_SEL   = '.Root__top-container';

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

    const RIGHT = '.Root__top-container > :has(#Desktop_PanelContainer_Id)';

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

/* Right panel fills whatever the library leaves. */
html.henge-on ${RIGHT} {
    width: auto !important;
    min-width: 0 !important;
}
html.henge-on #Desktop_PanelContainer_Id {
    width: 100% !important;
}

/* The library's own resizer now sits on the library/right-panel boundary and
   does the job; the right panel's resizer would fight it. */
html.henge-on ${RIGHT} > .LayoutResizer__resize-bar {
    display: none !important;
}

/* Right panel closed: the library takes the whole bottom row. */
html.henge-on .Root__top-container:not(:has(#Desktop_PanelContainer_Id)) > #Desktop_LeftSidebar_Id {
    grid-column: 1 / -1 !important;
    width: auto !important;
}

/* Lyrics cinema natively spans from the library's right edge to the window's.
   Stacked, that becomes the whole area above the bottom row. */
html.henge-on .Root__lyrics-cinema {
    grid-area: 1 / 1 / left-sidebar-start / -1 !important;
}
`;

    // ── State ─────────────────────────────────────────────────────────────────

    function readEnabled() {
        try { return localStorage.getItem(LS_ENABLED) !== '0'; } catch { return true; }
    }

    function writeEnabled(on) {
        try { localStorage.setItem(LS_ENABLED, on ? '1' : '0'); } catch {}
    }

    function notify(msg, isError = false) {
        try { Spicetify.showNotification(msg, isError, 3000); } catch {}
    }

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
        return document.documentElement.classList.contains(ROOT_CLASS);
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
            'library': [document.getElementById('Desktop_LeftSidebar_Id'), 40, 80],
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
            document.documentElement.classList.add(ROOT_CLASS);
            if (persist) writeEnabled(true);
            selfCheck();
        } catch (e) {
            warn('enable failed, reverting:', e);
            disable(true);
        }
    }

    function disable(persist = true) {
        document.documentElement.classList.remove(ROOT_CLASS);
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
                leftSidebar: !!el.querySelector('#Desktop_LeftSidebar_Id') || el.id === 'Desktop_LeftSidebar_Id',
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

    function recon() {
        const root = document.querySelector(ROOT_SEL);
        const cs = getComputedStyle(root);
        const attrsOf = el => Object.fromEntries([...el.attributes].map(a => [a.name, a.value]));
        const out = {
            henge: VERSION,
            spicetify: Spicetify.Config?.version,
            spotify: Spicetify.Platform?.version,
            window: [window.innerWidth, window.innerHeight],
            henge_on: isOn(),
            html: attrsOf(document.documentElement),
            body: attrsOf(document.body),
            root: {
                attrs: attrsOf(root),
                gridTemplateAreas: cs.gridTemplateAreas,
                gridTemplateColumns: cs.gridTemplateColumns,
                gridTemplateRows: cs.gridTemplateRows,
                vars: Object.fromEntries(
                    ['--left-sidebar-width', '--right-sidebar-width', '--panel-gap']
                        .map(v => [v, cs.getPropertyValue(v).trim()])
                ),
            },
            ancestors: (() => {
                const list = [];
                for (let el = root.parentElement; el && el !== document.body; el = el.parentElement) {
                    list.push({ tag: el.tagName.toLowerCase(), attrs: attrsOf(el) });
                }
                return list;
            })(),
            children: [...root.children].map(describe),
            styleTags: [...document.querySelectorAll('style, link[rel=stylesheet]')]
                .map(s => s.id || s.className || s.getAttribute('href') || '(anonymous style)'),
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
