// Offline check of Henge's generated layout CSS (no Spotify needed).
// Run with Windows Node from the repo root:
//   "/mnt/c/Program Files/nodejs/node.exe" tools/test-layout.js
// Extracts the slot model and buildLayoutCSS() from henge.js and prints the
// rules for a few layouts, plus swap/validation checks.
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, '..', 'henge.js'), 'utf8');
const slotsBlock = src.slice(src.indexOf('    const SLOTS = '), src.indexOf('    // ── Static CSS'));
const fnStart = src.indexOf('    function buildLayoutCSS');
const fnEnd = src.indexOf('    // ── Picker CSS');
const code = `const LEFT_ID='Desktop_LeftSidebar_Id'; const lsGet=()=>null;\n${slotsBlock}\n${src.slice(fnStart, fnEnd)}\nmodule.exports={buildLayoutCSS, withSource, validLayout, DEFAULT_LAYOUT};`;
const m = {}; new Function('module', code)(m);
const { buildLayoutCSS, withSource, validLayout, DEFAULT_LAYOUT } = m.exports;
const show = (name, l) => { console.log(`\n=== ${name} ${JSON.stringify(l)} valid=${validLayout(l)}`); console.log(buildLayoutCSS(l)); };
show('default', DEFAULT_LAYOUT);
show('panel top, main left', { top: 'panel', left: 'main', right: 'library' });
show('library none', { top: 'main', left: 'none', right: 'panel' });
show('pinned NPV + queue', { top: 'main', left: 'nowplaying', right: 'queue' });
show('top none', { top: 'none', left: 'main', right: 'panel' });
console.log('\nswap main<-library:', JSON.stringify(withSource(DEFAULT_LAYOUT, 'top', 'library')));
console.log('left->none:', JSON.stringify(withSource(DEFAULT_LAYOUT, 'left', 'none')));
console.log('invalid dup:', validLayout({ top: 'main', left: 'main', right: 'panel' }), 'no main:', validLayout({ top: 'library', left: 'none', right: 'panel' }));
