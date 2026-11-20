'use strict';
// faster-whisper ASR through the engine. Used by the pipeline as an OPTIONAL tier; every failure is reported to the
// caller as a rejected promise so the pipeline can fall back to whisper.cpp (nothing here is allowed to be fatal).

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {import('./engine-supervisor').EngineSupervisor} sup
 * @param {{audioPath:string, model?:string, language?:string, vad?:boolean, allowDownload?:boolean,
 *          pollMs?:number, timeoutMs?:number, isCancelled?:()=>boolean, onProgress?:(p:number,job:object)=>void}} opt
 * @returns {Promise<{words:{text:string,start:number,end:number}[], language:string|undefined, modelUsed:string, note:string|null}>}
 */
async function transcribeViaEngine(sup, opt) {
  const { audioPath, model = 'small', language = 'auto', vad = true, allowDownload = true, pollMs = 1000, timeoutMs = 6 * 3600 * 1000, isCancelled = () => false, onProgress = () => {} } = opt;
  if (sup.status.state !== 'ready') throw Object.assign(new Error('engine not ready'), { code: 'engine_unavailable' });
  const job = await sup.request('POST', '/api/v1/asr/transcribe', { audio_path: audioPath, model, language, vad, allow_download: allowDownload }, 15000);
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    if (isCancelled()) {
      try { await sup.request('DELETE', `/api/v1/asr/jobs/${job.id}`, undefined, 5000); } catch { /* best effort */ }
      throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
    }
    if (Date.now() > deadline) {
      try { await sup.request('DELETE', `/api/v1/asr/jobs/${job.id}`, undefined, 5000); } catch { /* best effort */ }
      throw Object.assign(new Error('engine ASR timeout'), { code: 'timeout' });
    }
    await sleep(pollMs);
    last = await sup.request('GET', `/api/v1/asr/jobs/${job.id}`, undefined, 10000);   // engine died => rejects => caller falls back
    onProgress(last.progress || 0, last);
    if (last.status === 'done') break;
    if (last.status === 'error') throw Object.assign(new Error((last.error && last.error.message) || 'engine ASR failed'), { code: (last.error && last.error.code) || 'asr_failed' });
    if (last.status === 'cancelled') throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
  }
  const words = (last.words || []).map((w) => ({ text: String(w.text || '').trim(), start: +w.start, end: +w.end }))
    .filter((w) => w.text && Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start);
  return { words, language: last.language || undefined, modelUsed: last.model_used, note: last.note || null };
}

module.exports = { transcribeViaEngine };
