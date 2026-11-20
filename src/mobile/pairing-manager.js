// SEVNT Pairing Manager — orchestrates the full mobile companion connection flow.
// Coordinates: LAN detection → tunnel (if needed) → QR code → pairing confirmation.

'use strict';

const { isLanAvailable } = require('./lan-detector');
const { createTunnelAdapter } = require('./tunnel-adapter');
const { MobileGateway } = require('./mobile-gateway');

class PairingManager {
  constructor(opts = {}) {
    this._gateway = new MobileGateway(opts.handlers || {});
    this._tunnel = null;
    this._tunnelProvider = opts.tunnelProvider || 'cloudflare';
    this._userData = opts.userData || '';
    this._onStatus = opts.onStatus || (() => {});
  }

  /**
   * Starts the full pairing flow.
   * Returns { pairingUrl, mode } where mode is 'lan' or 'remote'.
   * Caller should render the pairingUrl as a QR code.
   */
  async startPairing(opts = {}) {
    this._onStatus({ step: 'starting_gateway' });
    await this._gateway.start();

    let mode, pairingUrl;

    if (!opts.forceRemote && isLanAvailable()) {
      // LAN mode — faster, no tunnel needed
      mode = 'lan';
      this._onStatus({ step: 'lan_available' });
      ({ pairingUrl } = this._gateway.createPairingUrl(null));
    } else {
      // Remote mode — start tunnel
      mode = 'remote';
      this._onStatus({ step: 'starting_tunnel', provider: this._tunnelProvider });

      this._tunnel = createTunnelAdapter(this._tunnelProvider);
      const { url: tunnelUrl } = await this._tunnel.start(this._gateway.port, this._userData);

      this._onStatus({ step: 'tunnel_ready', tunnelUrl });
      ({ pairingUrl } = this._gateway.createPairingUrl(tunnelUrl));
    }

    this._onStatus({ step: 'waiting_for_scan', pairingUrl, mode });
    return { pairingUrl, mode };
  }

  /**
   * Stops the pairing session, kills tunnel, and disconnects HP.
   */
  async stopPairing() {
    this._onStatus({ step: 'stopping' });
    if (this._tunnel) {
      await this._tunnel.stop();
      this._tunnel = null;
    }
    await this._gateway.stop();
    this._onStatus({ step: 'stopped' });
  }

  get isActive() {
    return this._gateway.isRunning;
  }

  get tunnelUrl() {
    return this._tunnel?.url || null;
  }
}

module.exports = { PairingManager };
