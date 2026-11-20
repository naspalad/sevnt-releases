# SEVNT License System — API Contract

**Version:** 1.0.0  
**Base:** Google Apps Script Web App URL (set after deployment)  
**Method:** All requests use `POST` with JSON body  
**Auth:** Public endpoints require no auth. Admin endpoints require `admin_secret` in body.

---

## Common Response Format

All responses are JSON. HTTP status is always 200 (GAS limitation). Check `ok` field.

```json
{ "ok": true, ... }
{ "ok": false, "error": "ERROR_CODE", "message": "Human-readable description" }
```

Signed responses include a `sig` field (HMAC-SHA256 of sorted-key payload JSON).

---

## 1. `health`

Check service availability.

**Request:**
```json
{ "action": "health" }
```

**Response:**
```json
{ "ok": true, "version": "1.0.0", "timestamp": "2026-11-09T10:00:00.000Z" }
```

---

## 2. `activate`

Register a device for a license. Issues a device token (sent ONCE — store securely).

**Request:**
```json
{
  "action": "activate",
  "license_key":  "ABCDE-12345-FGHIJ-67890",
  "device_role":  "PRIMARY_LAPTOP",
  "machine_id":   "<sha256-of-hardware-fingerprint>",
  "device_name":  "My Laptop"
}
```

`device_role` values: `PRIMARY_LAPTOP` | `MOBILE_COMPANION`

**Success Response:**
```json
{
  "ok":           true,
  "device_token": "<96-char-hex>",
  "device_id":    "<uuid>",
  "license_id":   "<uuid>",
  "valid_until":  null,
  "issued_at":    "2026-11-09T10:00:00.000Z",
  "sig":          "<hmac-sha256-hex>"
}
```

**Error Codes:**

| Code | Meaning |
|------|---------|
| `LICENSE_NOT_FOUND` | License key does not exist |
| `LICENSE_REVOKED` | License has been revoked |
| `PAYMENT_NOT_COMPLETED` | Payment not confirmed |
| `DEVICE_SLOT_OCCUPIED_CONTACT_SEVNT_SUPPORT` | Slot taken by another device; contact support |
| `LAPTOP_NOT_ACTIVATED` | Mobile activation attempted before laptop |
| `INVALID_LICENSE_KEY_FORMAT` | Key format is wrong |
| `INVALID_MACHINE_ID` | Machine ID too short |

**Business Rules:**
- `MOBILE_COMPANION` can only be activated after `PRIMARY_LAPTOP` is active
- If the same machine re-activates (e.g. after OS reinstall), a new token is issued
- Different machine on occupied slot → `DEVICE_SLOT_OCCUPIED_CONTACT_SEVNT_SUPPORT`

---

## 3. `validate`

Validate a device token (called at app startup / revalidation interval).

**Request:**
```json
{
  "action":       "validate",
  "device_token": "<96-char-hex>",
  "machine_id":   "<sha256-of-hardware-fingerprint>"
}
```

**Success Response:**
```json
{
  "ok":           true,
  "license_id":   "<uuid>",
  "device_id":    "<uuid>",
  "device_role":  "PRIMARY_LAPTOP",
  "valid_until":  null,
  "issued_at":    "2026-11-09T10:00:00.000Z",
  "sig":          "<hmac-sha256-hex>"
}
```

**Error Codes:**

| Code | Meaning |
|------|---------|
| `TOKEN_INVALID` | Token not found in database |
| `MACHINE_MISMATCH` | Token does not match this machine |
| `DEVICE_REVOKED` | Device has been revoked |
| `LICENSE_REVOKED` | License has been revoked |

---

## 4. `deactivate` (Blocked by Design)

User-facing deactivation is **not supported**. Device management is Support-only.

**Response (always):**
```json
{
  "ok": false,
  "error": "OPERATION_NOT_PERMITTED",
  "message": "Device deactivation requires contacting SEVNT Support."
}
```

---

## 5. `support_reset_device` *(Admin Only)*

Revoke a specific device, freeing its slot for a new device.

**Request:**
```json
{
  "action":         "support_reset_device",
  "admin_secret":   "<ADMIN_SECRET>",
  "device_id":      "<uuid>",
  "reason":         "Customer replacing laptop",
  "ticket_id":      "TKT-20261109-001",
  "operator_email": "support@sevntstudio.com"
}
```

**Success Response:**
```json
{ "ok": true, "message": "Device revoked successfully" }
```

**Error Codes:** `DEVICE_NOT_FOUND`, `DEVICE_ALREADY_REVOKED`, `UNAUTHORIZED`

---

## 6. `support_recover_license` *(Admin Only)*

Revoke all devices for a license (invalidates all tokens) and optionally reissue the key.

**Request:**
```json
{
  "action":         "support_recover_license",
  "admin_secret":   "<ADMIN_SECRET>",
  "license_id":     "<uuid>",
  "reason":         "Customer lost access",
  "ticket_id":      "TKT-20261109-002",
  "operator_email": "support@sevntstudio.com",
  "reissue_key":    true
}
```

`reissue_key`: `true` = generate new license key and email to customer. `false` = only revoke devices.

**Success Response:**
```json
{
  "ok":              true,
  "new_license_key": "XXXXX-XXXXX-XXXXX-XXXXX",
  "message":         "License recovered. 2 device(s) revoked. New key delivered to customer@email.com"
}
```

`new_license_key` is `null` if `reissue_key` was `false`.

---

## 7. `lynk_webhook`

Receives payment events from Lynk.id.

**STATUS: BLOCKED** — Lynk.id public webhook documentation not accessible.  
`PRODUCTION_BLOCKED = true` and `LynkPaymentAdapter.SIGNATURE_BLOCKED = true`.  
All requests are logged but NOT processed.

**Response while blocked:**
```json
{
  "ok": false,
  "error": "INTEGRATION_BLOCKED",
  "message": "Lynk.id integration is pending documentation verification."
}
```

---

## 8. `scalev_webhook`

Receives payment events from Scalev.

**STATUS: FULLY BLOCKED** — `dev.scalev.com` developer documentation inaccessible (all sub-pages return 404 as of 2026-11-09).  
`ScalevPaymentAdapter.FULLY_BLOCKED = true`.  
All requests are rejected immediately.

**Response while blocked:**
```json
{
  "ok": false,
  "error": "INTEGRATION_BLOCKED",
  "message": "Scalev integration is fully blocked — developer documentation is not accessible."
}
```

**To unblock:** Obtain field names, signature algorithm, and webhook configuration from Scalev support or when `dev.scalev.com` becomes accessible.

---

## Offline Grace Period (Client-Side)

The server does not enforce offline grace — it is a client-side policy:

| Parameter | Value |
|-----------|-------|
| Revalidation interval | 3 days |
| Offline grace period | 7 days |
| Cache encryption | AES-256-GCM, key derived from machine ID |

Clients must NOT extend grace by rolling back system clock. See SECURITY.md.

---

## Rate Limits

GAS Web Apps are rate-limited by Google (default: 100 requests/second, shared across all users of the script). No explicit per-user rate limiting is implemented in Phase 1. Add if abuse is detected.
