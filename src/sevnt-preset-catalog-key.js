// SEVNT preset catalog Ed25519 public key.
// Used to verify the signature on preset catalog envelopes from the SEVNT catalog server.
// The corresponding private key lives ONLY on the SEVNT catalog server — never in the app.
//
// Generate a fresh key pair with:
//   openssl genpkey -algorithm ed25519 -out sevnt-catalog-private.pem
//   openssl pkey -in sevnt-catalog-private.pem -pubout -out sevnt-catalog-public.pem
// Then replace the PLACEHOLDER below with the content of sevnt-catalog-public.pem.
// Store the private key securely on the catalog server — never commit it.

'use strict';

const PUBLIC_KEY_PEM = process.env.SEVNT_CATALOG_PUBLIC_KEY || `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAZoqSpU2zmSV6n7Ms85cODz+ofhWAiNxf0TDeGM8WgkU=
-----END PUBLIC KEY-----
`;

module.exports = { PUBLIC_KEY_PEM };
