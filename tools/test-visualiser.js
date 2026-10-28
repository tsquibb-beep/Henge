// Offline check of the visualiser's maths (no Spotify needed).
// Run with Windows Node from the repo root:
//   node tools/test-visualiser.js
// Extracts the pure block from henge.js (between the "Visualiser maths" and
// "Visualiser view" markers) and checks it against a synthetic analysis.
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, '..', 'henge.js'), 'utf8');
const start = src.indexOf('    // ── Visualiser maths');
const end = src.indexOf('    // ── Visualiser view');
if (start < 0 || end < start) throw new Error('visualiser markers not found in henge.js');
const code = `${src.slice(start, end)}\nmodule.exports={indexAt, loudnessAt, dbToLevel, beatPulse, pitchesAt, catmull, chromaAt, ease, isTrackUri, VIS_DB_FLOOR};`;
const m = {}; new Function('module', code)(m);
const { indexAt, loudnessAt, dbToLevel, beatPulse, pitchesAt, catmull, chromaAt, ease, isTrackUri, VIS_DB_FLOOR } = m.exports;

let pass = 0, fail = 0;
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
function check(name, ok) {
    if (ok) pass++; else { fail++; console.log(`FAIL ${name}`); }
}

// 20 segments of 0.5s from t=0, peak 0.1s in; pitches rotate per segment.
const segs = Array.from({ length: 20 }, (_, i) => ({
    start: i * 0.5, duration: 0.5,
    loudness_start: -30, loudness_max: -5, loudness_max_time: 0.1, loudness_end: 0,
    pitches: Array.from({ length: 12 }, (_, k) => (k === i % 12 ? 1 : 0.1)),
}));
const beats = Array.from({ length: 10 }, (_, i) => ({ start: i + 0.25, duration: 1 }));

// indexAt
check('indexAt before first', indexAt(segs, -1) === -1);
check('indexAt empty', indexAt([], 3) === -1);
check('indexAt at 0', indexAt(segs, 0) === 0);
check('indexAt just before boundary', indexAt(segs, 0.4999) === 0);
check('indexAt on boundary', indexAt(segs, 0.5) === 1);
check('indexAt last', indexAt(segs, 9.99) === 19);
check('indexAt past end', indexAt(segs, 100) === 19);
let hint = -1, agree = true;
for (let t = -0.3; t < 11; t += 0.037) {           // playback: hint follows along
    hint = indexAt(segs, t, hint);
    if (hint !== indexAt(segs, t)) agree = false;
}
check('indexAt with running hint matches search', agree);
check('indexAt after seek back (stale hint)', indexAt(segs, 1.2, 15) === 2);
check('indexAt after seek forward (stale hint)', indexAt(segs, 8.2, 1) === 16);
check('indexAt beats', indexAt(beats, 3.3) === 3 && indexAt(beats, 0.2) === -1);

// loudnessAt
const [s0, s1] = segs;
check('loudness at segment start', near(loudnessAt(s0, s1, 0), -30));
check('loudness at peak', near(loudnessAt(s0, s1, 0.1), -5));
check('loudness rising', loudnessAt(s0, s1, 0.05) > -30 && loudnessAt(s0, s1, 0.05) < -5);
check('loudness at end meets next start', near(loudnessAt(s0, s1, 0.5), s1.loudness_start));
check('loudness last segment fades to floor', near(loudnessAt(segs[19], undefined, 10), VIS_DB_FLOOR));
check('loudness zero peak time', near(loudnessAt({ ...s0, loudness_max_time: 0 }, s1, 0), -5));
let cont = true;                                   // no jumps across a boundary
for (let i = 0; i < 19; i++) {
    const t = segs[i + 1].start;
    if (!near(loudnessAt(segs[i], segs[i + 1], t), loudnessAt(segs[i + 1], segs[i + 2], t), 1e-9)) cont = false;
}
check('loudness continuous across segments', cont);

// dbToLevel
check('level 0 dB = 1', near(dbToLevel(0), 1));
check('level floor = 0', near(dbToLevel(VIS_DB_FLOOR), 0));
check('level below floor = 0', dbToLevel(-90) === 0);
check('level above 0 dB clamped', dbToLevel(3) === 1);
let mono = true;
for (let db = -50; db < 0; db += 0.5) if (dbToLevel(db + 0.5) < dbToLevel(db)) mono = false;
check('level monotonic', mono);
check('quiet visibly lower than loud', dbToLevel(-25) < 0.3 && dbToLevel(-5) > 0.75);

// beatPulse
check('pulse none without beat', beatPulse(undefined, 1) === 0);
check('pulse before beat', beatPulse(beats[0], 0.1) === 0);
check('pulse on beat', near(beatPulse(beats[0], 0.25), 1));
check('pulse decays by 0.3s', beatPulse(beats[0], 0.55) < 0.1);

// pitchesAt
check('pitches at start', pitchesAt(s0, s1, 0).every((p, i) => near(p, s0.pitches[i])));
check('pitches at end = next', pitchesAt(s0, s1, 0.5).every((p, i) => near(p, s1.pitches[i])));
check('pitches without next', pitchesAt(segs[19], undefined, 9.9).every((p, i) => near(p, segs[19].pitches[i])));
check('pitches 12 values', pitchesAt(s0, s1, 0.2).length === 12);

// catmull / chromaAt
check('catmull f=0 is p1', near(catmull(0, 2, 5, 1, 0), 2));
check('catmull f=1 is p2', near(catmull(0, 2, 5, 1, 1), 5));
const p = s0.pitches;
check('chroma through points', near(chromaAt(p, 0), 1) && near(chromaAt(p, 5), 0.1));
check('chroma wraps', near(chromaAt(p, 11.999), chromaAt(p, -0.001), 1e-3));
check('chroma negative u', Number.isFinite(chromaAt(p, -3.5)));

// ease
check('ease dt 0 holds', ease(0, 1, 0, 0.1) === 0);
check('ease converges', near(ease(0, 1, 10, 0.1), 1));
check('ease partial', ease(0, 1, 0.1, 0.1) > 0.5 && ease(0, 1, 0.1, 0.1) < 0.7);

// isTrackUri
check('track uri', isTrackUri('spotify:track:4uLU6hMCjMI75M1A2tKUQC'));
check('local file not a track', !isTrackUri('spotify:local:Artist:Album:Title:180'));
check('episode not a track', !isTrackUri('spotify:episode:abc'));
check('missing uri', !isTrackUri(undefined) && !isTrackUri(null));

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
