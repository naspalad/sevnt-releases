# SEVNT License System — Security Design

---

## 1. Secret Management

| Secret | Location | Never in |
|--------|----------|----------|
| `ADMIN_SECRET` | Script Properties (server-only) | Client code, React, Electron renderer, git |
| `HMAC_SIGNING_KEY` | Script Properties | Client code, git |
| `SPREADSHEET_ID` | Script Properties | Public code (not sensitive, but keep in Properties) |
| Ed25519 private key (Phase 3) | Script Properties | Anywhere else |

**Rule:** No secret ever appears in `apps-script/` source files. All secrets are set via `setupScriptProperties()` from the Apps Script editor and stored in Google's server-side secure storage.

---

## 2. License Key Security

- Generated with `Utilities.getUuid()` × 2 (UUID v4, 256 bits combined, truncated to 95-bit key space)
- Format: `XXXXX-XXXXX-XXXXX-XXXXX` (uppercase hex)
- Stored as `SHA256('license:' + normalized_key)` — plaintext never in database
- Only 8-char prefix stored for support lookup
- Not logged, not in URLs, not in error messages

---

## 3. Device Token Security

- Generated with `Utilities.getUuid()` × 3 (384 bits entropy)
- Sent to client ONCE at activation — never re-sent
- Stored as `SHA256('device_token:' + raw_token)` — only hash in database
- Tokens are role-bound: laptop token fails machine-mismatch check if used from mobile machine
- Revocation immediately invalidates token (hash removed from ACTIVE devices)

---

## 4. Machine Fingerprint

- Client sends raw `machine_id` (hardware fingerprint)
- Server stores `SHA256('machine:' + machine_id)` — raw value never in database
- Matching is hash comparison — if machine changes, token fails machine_mismatch

---

## 5. Admin Authentication

- `admin_secret` checked via HMAC-safe comparison (both sides hashed before compare)
- All admin actions logged in AUDIT_LOG with `operator_email` and `ticket_id`
- `ticket_id` is required for every support operation — no anonymous support actions
- Admin secret is never returned in any response

---

## 6. Response Signing

**Current (Phase 1):** HMAC-SHA256 using server-only `HMAC_SIGNING_KEY`.

Client verification status:
- **SEVNT Studio:** `SEVNT_SKIP_SIG_VERIFY=true` during Phase 1 development
- **Phase 3:** Replace with Ed25519 or RSA-SHA256 (client can verify with public key only)

**Why not HMAC for client verification?**
HMAC requires the client to know the key, which would expose the server secret. Phase 3 will use asymmetric signing (RSA or Ed25519) so the client holds only a public key.

---

## 7. Offline Grace Period Security

**Client-side policy:**
- Cache encrypted with AES-256-GCM, key derived from machine ID
- 3-day revalidation interval
- 7-day maximum offline grace

**Clock manipulation risk:**
- If user rolls back system clock, `age = now - last_validated_at` becomes small → revalidation skipped
- **Mitigation (Phase 3):** Server returns `server_time` in validate response. Client compares local time vs server time. Delta > 24h → force online revalidation.
- **Current status (Phase 1):** Not yet implemented in SEVNT client. NOTED as known gap.

**Revocation while offline:**
- If device is revoked, the server sets `device.status = REVOKED`
- Next online validation will return `DEVICE_REVOKED` (terminal error) → client clears cache
- During offline grace, revocation is NOT enforced — user can run app for up to 7 days
- **Mitigation:** Keep offline grace short (7 days). For immediate revocation, server-side is instant; client will catch it at next online contact.

---

## 8. Concurrency

- `LicenseService.activate()` acquires `LockService.getScriptLock()` (15s timeout)
- Prevents two simultaneous requests from occupying the same slot
- GAS LockService is process-level — protects against concurrent doPost() invocations
- Note: GAS is single-instance per deployment; under very high load, requests queue naturally

---

## 9. Known Limitations (GAS Platform)

| Limitation | Impact | Mitigation |
|------------|--------|------------|
| No CSPRNG API | License/token generation uses UUID v4 (Google server-side, acceptable entropy) | Phase 3: consider external entropy source |
| No timing-safe equals | Admin secret compared via hash of both sides | Low risk in server-side GAS context |
| No HTTP status codes | All responses are 200; `ok` field carries status | Client must check `ok === false` |
| No Ed25519 native | HMAC-SHA256 for Phase 1 | Phase 3: implement Ed25519 via pure-JS library in GAS |
| Spreadsheet as DB | Full-sheet scans O(n) | Acceptable for < 5K licenses; migrate to Firestore/D1 at scale |
| Shared quota | Multiple users share GAS daily quota | Monitor execution logs; add caching if needed |
