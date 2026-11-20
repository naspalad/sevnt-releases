// Tunnel adapter for SEVNT mobile companion remote access.
// Abstracts tunnel provider behind a common interface.
// Current implementation: Cloudflare Quick Tunnels (no account required).
// Future: custom SEVNT relay server.

'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// ─── Cloudflare Quick Tunnel ──────────────────────────────────────────────────

class CloudflareQuickTunnel {
  constructor() {
    this._proc = null;
    this._url = null;
  }

  /**
   * Returns the path where cloudflared binary should be stored.
   */
  _binaryPath(userData) {
    const ext = process.platform === 'win32' ? '.exe' : '';
    return path.join(userData, 'tunnel-tools', `cloudflared${ext}`);
  }

  /**
   * Downloads cloudflared binary if not already present.
   * Uses bundle-download.js from SOCL (unchanged — pure download utility).
   */
  async ensureBinary(userData) {
    const binPath = this._binaryPath(userData);
    if (fs.existsSync(binPath)) return binPath;

    fs.mkdirSync(path.dirname(binPath), { recursive: true });

    // Pin to a specific cloudflared version — do NOT use 'latest' in production.
    // Update version + hashes after testing each new release.
    // TODO: Add actual SHA256 hashes before shipping (run: sha256sum cloudflared-*)
    // Pinned version: 2024.11.0 (update this when upgrading)
    const CF_VERSION = '2024.11.0';
    const BASE = `https://github.com/cloudflare/cloudflared/releases/download/${CF_VERSION}`;
    const manifest = {
      'win32-x64': {
        url: `${BASE}/cloudflared-windows-amd64.exe`,
        sha256: null,  // TODO: set actual SHA256 after downloading and verifying
      },
      'darwin-arm64': {
        url: `${BASE}/cloudflared-darwin-arm64`,
        sha256: null,  // TODO
      },
      'darwin-x64': {
        url: `${BASE}/cloudflared-darwin-amd64`,
        sha256: null,  // TODO
      },
    };

    const key = `${process.platform}-${process.arch}`;
    const entry = manifest[key];
    if (!entry) throw new Error(`cloudflared: unsupported platform ${key}`);

    const { download } = require('../bundle-download');
    const { sha256 } = await download(entry.url, binPath);

    if (entry.sha256) {
      if (sha256 !== entry.sha256) {
        fs.unlinkSync(binPath);
        throw new Error(`cloudflared binary hash mismatch — aborting. Expected ${entry.sha256}, got ${sha256}`);
      }
    } else {
      // Log warning when hash is not configured — do not silently skip verification
      console.warn('[tunnel-adapter] WARNING: cloudflared SHA256 not configured. Binary not verified. Set sha256 in manifest before production deployment.');
    }

    if (process.platform !== 'win32') {
      fs.chmodSync(binPath, 0o755);
    }

    return binPath;
  }

  /**
   * Starts the tunnel for the given local port.
   * Resolves with { url, provider } once the tunnel URL is available.
   */
  async start(localPort, userData) {
    if (this._proc) await this.stop();

    const binary = await this.ensureBinary(userData);
    this._proc = spawn(binary, ['tunnel', '--url', `http://localhost:${localPort}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Cloudflare tunnel timeout — no URL received in 15 seconds'));
      }, 15000);

      const handleOutput = (data) => {
        const text = data.toString();
        const match = text.match(/https:\/\/[^\s]+\.trycloudflare\.com/);
        if (match) {
          clearTimeout(timeout);
          this._url = match[0];
          resolve({ url: this._url, provider: 'cloudflare' });
        }
      };

      this._proc.stderr.on('data', handleOutput);
      this._proc.stdout.on('data', handleOutput);

      this._proc.on('exit', (code) => {
        clearTimeout(timeout);
        if (!this._url) reject(new Error(`cloudflared exited with code ${code}`));
      });
    });
  }

  /**
   * Stops the tunnel process.
   */
  async stop() {
    if (this._proc) {
      this._proc.kill();
      this._proc = null;
      this._url = null;
    }
  }

  get url() { return this._url; }
  get isRunning() { return !!this._proc; }
}

// ─── Tunnel Factory ───────────────────────────────────────────────────────────

/**
 * Creates a tunnel adapter. Currently only 'cloudflare' is implemented.
 * Future: 'sevnt-relay' for the custom SEVNT relay server.
 */
function createTunnelAdapter(provider = 'cloudflare') {
  if (provider === 'cloudflare') return new CloudflareQuickTunnel();
  throw new Error(`Unknown tunnel provider: ${provider}`);
}

module.exports = { createTunnelAdapter, CloudflareQuickTunnel };
