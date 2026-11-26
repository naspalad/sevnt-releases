'use strict';

// QA-only sanitized settings. Mirrors renderer.js CFG_FALLBACK.
// This helper never reads APPDATA or personal API credentials.
const DEFAULTS = Object.freeze({
  clipCount: 5, clipDuration: '60', clipMode: 'auto', manualSegments: [],
  deadAirCut: true, deadAirLevel: 'natural', format: 'face', resolution: '1080p',
  burnSubtitles: true, smartTrack: false, trackerAsdMode: 'blendshape',
  subtitleLang: 'auto', subtitleStyle: 'neon_green', subtitleGlow: true,
  subtitleBoxColor: '', subtitleFontSize: 64, subtitleFont: '',
  subtitleTracking: 0, subtitleOffsetMs: 0, subtitleY: 540, subtitleX: 540,
  subtitleAnim: 'pop', collageBroll: false, hookTeaser: false, hookProvider: 'groq',
  aiProvider: '', apiKey: '', geminiKey: '', groqKey: '', freeModel: '',
  openaiKey: '', openaiModel: 'gpt-4o-mini',
  anthropicKey: '', anthropicModel: 'claude-haiku-4-5',
  openrouterKey: '', openrouterModel: 'openrouter/free', openrouterFallbacks: '',
  sumopodKey: '', sumopodModel: 'deepseek-v4-pro',
  localAsr: 'ask', whisperModelSize: 'small', asrEngine: 'whispercpp',
  model: '', baseUrl: '', cookiesPath: '', exportPath: '', lastUrl: ''
});

function createQaSettings(overrides = {}) {
  return { ...DEFAULTS, ...overrides };
}
module.exports = { createQaSettings };
