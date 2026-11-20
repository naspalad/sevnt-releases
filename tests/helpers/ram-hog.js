// Test helper: occupy physical RAM so that only LEAVE_FREE_MB stay free, hold it for HOLD_S seconds, then exit.
// Usage: node tests/helpers/ram-hog.js <leave_free_mb> <hold_seconds>
const os = require('os');
const leave = Number(process.argv[2] || 300) * 1048576;
const hold = Number(process.argv[3] || 120) * 1000;
const chunks = [];
const step = 64 * 1048576;
while (os.freemem() > leave + step) { const b = Buffer.alloc(step); for (let i = 0; i < step; i += 4096) b[i] = 1; chunks.push(b); }
console.log('hog: holding ' + chunks.length * 64 + ' MB, free now ' + Math.round(os.freemem() / 1048576) + ' MB');
setTimeout(() => process.exit(0), hold);
