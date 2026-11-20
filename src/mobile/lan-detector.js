// Detects the laptop's LAN IP address for mobile companion connectivity.

'use strict';

const os = require('os');

/**
 * Returns all non-loopback IPv4 addresses on the local machine.
 */
function getLanAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];

  for (const iface of Object.values(interfaces)) {
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) {
        addresses.push(addr.address);
      }
    }
  }
  return addresses;
}

/**
 * Returns the primary LAN IP (first non-loopback IPv4), or null if none found.
 */
function getPrimaryLanAddress() {
  const addrs = getLanAddresses();
  return addrs[0] || null;
}

/**
 * Checks if a given IP is reachable from the same LAN.
 * Lightweight: just confirms we have a local address (doesn't probe HP).
 */
function isLanAvailable() {
  return getLanAddresses().length > 0;
}

module.exports = { getLanAddresses, getPrimaryLanAddress, isLanAvailable };
