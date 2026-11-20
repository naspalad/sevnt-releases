'use strict';
// Pipeline tier "faster-whisper via local engine". Returns { cues, words, language } or null (= use the next tier).
// It never throws for engine problems: only cancellation propagates, so whisper.cpp stays a guaranteed fallback.

const { transcribeViaEngine } = require('./engine-asr');

async function engineAsrTier(o) {
  const { engine, model, audioPath, durationSec, lang, localAsrPref, log, prog, isCancelled, transcriptLooksUsable, humanDuration } = o;
  if (!engine || engine.status.state !== 'ready') {
    log(`▶ ASR faster-whisper: engine lokal belum siap (${(engine && engine.status.state) || 'tidak aktif'}) — memakai whisper.cpp`, 'yellow');
    return null;
  }
  let caps;
  try { caps = await engine.request('GET', '/api/v1/system/whisper-capabilities', undefined, 20000); } catch (e) { log(`⚠ ASR faster-whisper: engine tidak menjawab (${e.message}) — memakai whisper.cpp`, 'yellow'); return null; }
  if (!caps.faster_whisper_available) { log('⚠ ASR faster-whisper: runtime engine tanpa faster-whisper — memakai whisper.cpp', 'yellow'); return null; }
  const cached = !!(caps.models[model] && caps.models[model].cached);
  if (!cached && localAsrPref !== true) {
    log(`▶ ASR faster-whisper: model '${model}' belum diunduh. Pilih "Izinkan — unduh otomatis" di Settings → Transkrip offline, atau pakai whisper.cpp — memakai whisper.cpp`, 'yellow');
    return null;
  }
  log(`▶ ASR: transkrip via faster-whisper (${model}) di engine lokal${cached ? '' : ' — mengunduh model dulu'}…`, 'lime');
  prog(`transkrip via faster-whisper (${model})…`, 44);
  const t0 = Date.now();
  let res;
  try {
    res = await transcribeViaEngine(engine, {
      audioPath, model, language: lang || 'auto', allowDownload: localAsrPref === true, isCancelled, pollMs: 1500,
      onProgress: (p) => prog(`transkrip via faster-whisper… ${Math.round(p * 100)}%`, 44 + Math.min(0.89, p * 0.9)),
    });
  } catch (e) {
    if (e.code === 'cancelled') throw e;
    log(`⚠ ASR faster-whisper gagal (${e.message}) — beralih ke whisper.cpp`, 'yellow');
    return null;
  }
  if (res.note) log(`▶ ASR faster-whisper: ${res.note}`, 'yellow');
  if (!transcriptLooksUsable(res.words, durationSec)) {
    log(`⚠ ASR faster-whisper: hasil tidak layak (${res.words.length} kata untuk audio ${humanDuration(durationSec)}) — mencoba whisper.cpp`, 'yellow');
    return null;
  }
  log(`▶ ASR faster-whisper: ${res.words.length} kata dalam ${humanDuration((Date.now() - t0) / 1000)}${res.language ? ` (bahasa: ${res.language})` : ''}`, 'lime');
  return { cues: res.words, words: res.words, language: res.language };
}

module.exports = { engineAsrTier };
