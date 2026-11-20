/**
 * SEVNT Catalog Worker
 * Serves a signed preset catalog at GET /v1/catalog
 * Ed25519 signature generated with sevnt-catalog-private.pem
 */

// Signed catalog envelope — update payload + sig when catalog changes
const CATALOG_ENVELOPE = {"payload":"{\"version\":1,\"hookPresets\":[],\"captionTemplates\":[],\"videoFx\":[]}","sig":"TTSooyjxKZ6NphoOwa2nszWPwoaXQyBdVi1ucV689Or1vccRO/wapsl91VbE5EGiwUbPf3BUDJHfOvZFG4s9Dg=="};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === '/health' || url.pathname === '/') {
      return new Response(JSON.stringify({ ok: true, service: 'SEVNT Catalog', version: 1 }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // Catalog endpoint
    if (url.pathname === '/v1/catalog' && request.method === 'GET') {
      return new Response(JSON.stringify(CATALOG_ENVELOPE), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=3600',
          'Access-Control-Allow-Origin': '*',
        }
      });
    }

    return new Response('Not Found', { status: 404 });
  }
};
