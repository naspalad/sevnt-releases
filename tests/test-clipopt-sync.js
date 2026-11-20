// Pure test of syncCuesToClipOptions() from renderer.js (the functions are cut out of the file and run in a vm sandbox).
'use strict';
const fs = require('fs'); const vm = require('vm'); const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
const grab = (name) => {
  const m = new RegExp('^function ' + name + '\\b[\\s\\S]*?^}\\r?\\n', 'm').exec(src);
  if (!m) throw new Error('function not found: ' + name);
  return m[0];
};
const names = ['ensureTokens', 'flattenClipWords', 'wpcNumR', 'autoChunkKin', 'kinChunksR', 'rechunkCuesCustom', 'syncCuesToClipOptions'];
const code = names.map(grab).join('\n');
const CustomChunks = require('../src/custom-chunks.js');
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n); } };
function sandbox(cfg) {
  const ctx = { state: { cfg }, window: { CustomChunks }, console, isFinite };
  vm.createContext(ctx); vm.runInContext(code, ctx); return ctx;
}
const words = 'ini adalah contoh kalimat yang cukup panjang untuk diuji'.split(' ').map((t, i) => ({ text: t, start: i * 0.4, end: i * 0.4 + 0.35 }));
const baked = (n) => { const out = []; for (let i = 0; i < words.length; i += n) { const g = words.slice(i, i + n); out.push({ start: g[0].start, end: g[g.length - 1].end, text: g.map((w) => w.text).join(' '), tokens: g.map((w) => ({ text: w.text })) }); } return out; };
console.log('▶ Clip Options chunk setting vs Caption Editor cues');
{ const c = sandbox({ subtitleWordsPerChunk: 1 }); const clip = { words, cueWords: baked(3), end: 5, start: 0 };
  const changed = c.syncCuesToClipOptions(clip);
  ok(changed && clip.cueWords.length === words.length && clip.cueWords.every((q) => q.text.split(' ').length === 1), 'unedited clip baked at 3w becomes 1 word per cue when the setting is 1w'); }
{ const c = sandbox({ subtitleWordsPerChunk: 3 }); const clip = { words, cueWords: baked(3), end: 5, start: 0 }; const before = JSON.stringify(clip.cueWords);
  ok(c.syncCuesToClipOptions(clip) === false && JSON.stringify(clip.cueWords) === before, 'already matching: nothing changes'); }
{ const c = sandbox({ subtitleWordsPerChunk: 1 }); const cues = baked(3); cues[1].text = 'KOREKSI MANUAL'; const clip = { words, cueWords: cues, end: 5, start: 0 };
  ok(c.syncCuesToClipOptions(clip) === false && clip.cueWords[1].text === 'KOREKSI MANUAL', 'hand-edited text is NEVER overwritten'); }
{ const c = sandbox({ subtitleWordsPerChunk: 1 }); const cues = baked(3).slice(1); const clip = { words, cueWords: cues, end: 5, start: 0 };
  ok(c.syncCuesToClipOptions(clip) === false && clip.cueWords.length === cues.length, 'a cue the user deleted is NEVER restored'); }
{ const c = sandbox({ subtitleWordsPerChunk: 1 }); const clip = { words, cueWords: baked(3), chunkMode: 'custom', customChunkRules: [{ start: 0, end: 5, words: 2 }], end: 5, start: 0 }; const before = clip.cueWords.length;
  ok(c.syncCuesToClipOptions(clip) === false && clip.cueWords.length === before, 'custom chunk mode is left alone'); }
{ const c = sandbox({ subtitleWordsPerChunk: 1 }); const clip = { cueWords: baked(3) };
  ok(c.syncCuesToClipOptions(clip) === false, 'no word list: no change (cannot rebuild)'); }
{ const c = sandbox({ subtitleWordsPerChunk: 1 }); const cues = baked(3); cues[1].tokens[0].style = { color: '#ff0000', fn: 'Anton' }; const clip = { words, cueWords: cues, end: 5, start: 0 }; const before = JSON.stringify(clip.cueWords);
  ok(c.syncCuesToClipOptions(clip) === false && JSON.stringify(clip.cueWords) === before, 'a word with its own colour/font is NEVER lost by re-chunking'); }
console.log('\nResults: ' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
