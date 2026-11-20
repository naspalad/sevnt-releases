'use strict';
// [CRASH-TELEMETRY] Reload a crashed renderer, but never in a loop: a page that
// crashes on load would otherwise reload forever. `history` holds the times of
// the reloads already done (mutated); returns whether one more is allowed now.
const WINDOW_MS = 60_000;
const MAX_RELOADS = 2;

function allowRendererReload(history, now = Date.now()) {
  while (history.length && now - history[0] >= WINDOW_MS) history.shift();
  if (history.length >= MAX_RELOADS) return false;
  history.push(now);
  return true;
}

module.exports = { allowRendererReload, WINDOW_MS, MAX_RELOADS };
