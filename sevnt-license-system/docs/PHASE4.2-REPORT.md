# SEVNT License System — Phase 4.2 Report
## Dual Webhook Diagnostic Setup

**Date:** 2026-11-09  
**Status:** DEV implementation complete — pending GAS deployment and live webhook testing  
**Security:** DIAGNOSTIC_MODE only — no live license issuance, no production data touched

---

## 1. Documentation Research

### 1.1 Lynk.id

**Source:** https://documenter.getpostman.com/view/3211564/2sB2cVf2Kp  
**Status:** ✅ Accessible and verified

**Verified findings:**

| Item | Verified Value |
|------|---------------|
| Signature header | `X-Lynk-Signature` |
| Signature algorithm | SHA256(`amount` + `refId` + `message_id` + `merchant_key`) → hex |
| Order reference field | `refId` |
| Amount field | `amount` (represents grandTotal) |
| Signature input field | `message_id` |

**Not yet confirmed via diagnostic:**
- Exact field name for buyer email (candidates: `buyer_email`, `email`, `customer_email`)
- Exact status value for successful payment (candidates: `success`, `paid`, `PAID`, `SUCCESS`)
- Complete list of fields present in live webhook payload

**Important constraint:**  
Lynk.id likely stores ONE webhook URL per account. The existing webhook URL must NOT be changed without the account owner confirming that the previous integration will not be affected.

---

### 1.2 Scalev

**Source:** https://dev.scalev.com/docs/webhooks-overview and sub-pages  
**Status:** ✅ Accessible and verified (correct URL pattern: `/docs/<slug>`, not `/guides/<slug>`)

**Note:** In Phase 4, Scalev sub-pages returned 404 at paths like `/getting-started` and `/api-reference`. The correct paths are under `/docs/`. This was corrected in Phase 4.2.

**Verified findings:**

| Item | Verified Value |
|------|---------------|
| Signature header | `X-Scalev-Hmac-Sha256` |
| Signature algorithm | HMAC-SHA256(raw_body_bytes, signing_secret) → **Base64** (not hex) |
| Webhook signing secret | From Settings > Developers > Webhooks (NOT the API key) |
| Order ID field | `data.order_id` (e.g. `"250130JQHFZG"`) |
| Payment status field | `data.payment_status` |
| Payment status values | `"paid"` \| `"settled"` \| `"unpaid"` \| `"conflict"` |
| Paid statuses | `"paid"`, `"settled"` |
| Buyer email field | `data.destination_address.email` |
| Revenue field | `data.gross_revenue` (string, e.g. `"149724.00"`) |
| Event field | `event` |
| Idempotency key | `unique_id` (top-level) |
| Test event name | `business.test_event` (sent on webhook URL save — MUST return 2xx) |
| Primary license event | `payment.received` |
| Required plan | Basic plan or higher |
| Dashboard path | Settings > Developers > Webhooks |

**Critical:**  
The Scalev API key (`sk_...` / `rk_...`) is **NOT** the webhook signing secret. The docs explicitly state: *"API keys are not webhook secrets and are not used to validate webhook deliveries."*  
The signing secret is a separate value shown in Settings > Developers > Webhooks.

---

## 2. GAS Header Limitation — Critical Architectural Finding

**Problem:** Google Apps Script `doPost(e)` does NOT expose arbitrary HTTP headers.

| Item | Status |
|------|--------|
| `e.postData.contents` | ✅ Readable — raw body string |
| `e.postData.type` | ✅ Readable — content type |
| `e.parameter` | ✅ Readable — query string params |
| `X-Lynk-Signature` header | ❌ NOT readable in GAS |
| `X-Scalev-Hmac-Sha256` header | ❌ NOT readable in GAS |

**Issue tracker:** https://issuetracker.google.com/issues/36763610

**Impact:**
- Lynk.id: Signature header cannot be read; constant-time comparison cannot be performed in pure GAS
- Scalev: Signature header cannot be read; raw-bytes HMAC cannot be verified in pure GAS

**Production path — middleware required:**  
For production webhook processing, a middleware layer (Cloud Run or Cloud Functions) is required to:
1. Read the `X-Lynk-Signature` / `X-Scalev-Hmac-Sha256` header
2. Verify the signature against the payload
3. Forward the verified request to the GAS Web App endpoint (optionally forwarding the signature value as a query param or body field for double-checking)

This architecture decision is documented in both adapter files (`LynkPaymentAdapter.gs:SIGNATURE_BLOCKED` and `ScalevPaymentAdapter.gs:SIGNATURE_BLOCKED`).

**Current status:** `SIGNATURE_BLOCKED = true` in both adapters. `PRODUCTION_BLOCKED = true` in `PaymentService.gs`. Neither will process live payments until middleware is deployed and tested.

---

## 3. Files Created / Modified

### New Files

| File | Purpose |
|------|---------|
| `modules/DiagnosticService.gs` | DEV-only webhook capture mode — receives requests, logs structure, never issues licenses |
| `modules/PaymentNormalizer.gs` | Provider-agnostic NormalizedTransaction contract |
| `modules/LynkPaymentAdapter.gs` | Lynk.id webhook adapter with verified FIELDS |
| `modules/ScalevPaymentAdapter.gs` | Scalev webhook adapter with verified FIELDS and EVENTS |

### Modified Files

| File | Change |
|------|--------|
| `Code.gs` | Added `scalev_webhook` route; updated `handleLynkWebhook()` and `handleScalevWebhook()` with diagnostic mode branching and `business.test_event` special handling |
| `modules/PaymentService.gs` | Rewritten as provider-agnostic dual-provider processor; `handleScalevWebhook()` updated with `PRODUCTION_BLOCKED` guard |
| `modules/DatabaseService.gs` | Added `findPaymentByCompositeKey(compositeKey)` |
| `tests/TestRunner.gs` | Added 4 Phase 4.2 test suites (~25 tests); fixed stale `handleWebhook` reference |

---

## 4. Diagnostic Mode Design

### Activation

Diagnostic mode is controlled by Script Properties:

| Property | Value | Effect |
|----------|-------|--------|
| `DIAGNOSTIC_MODE` | `"true"` | Enables capture-only mode |
| `PRODUCTION_DEPLOYMENT` | `"true"` | **Blocks** diagnostic mode entirely (safety guard) |

**To enable diagnostic mode in DEV:**
1. Open Apps Script editor → Project Settings → Script Properties
2. Add: `DIAGNOSTIC_MODE` = `true`
3. Confirm `PRODUCTION_DEPLOYMENT` is NOT set to `true`

### What Diagnostic Mode Does

When `DIAGNOSTIC_MODE=true`:
- Webhook body is received and parsed normally
- Field names, types, and structure depth are captured (NOT values)
- Sanitized metadata written to `AUDIT_LOG` sheet with `event_type='WEBHOOK_DIAGNOSTIC'`
- Always returns `HTTP 200` with `{"ok": true, "mode": "diagnostic"}`
- **No license is created**
- **No email is sent**
- **No PAYMENTS row is written**
- **No production data is touched**

### What Diagnostic Mode Captures

```
{
  received_at:     ISO8601 timestamp,
  provider:        "lynk" | "scalev",
  event_type:      "payment.received" | "business.test_event" | ...,
  parse_result:    "ok" | "null" | "test_event",
  field_names:     ["event", "unique_id", "data", ...],
  field_types:     {"event": "string", "data": "object", ...},
  field_depths:    {"event": 1, "data.order_id": 2, ...},
  gas_event_meta:  {
    content_type:      "application/json",
    body_length:       <number>,
    query_params:      {...},
    http_method:       "POST",
    headers_readable:  false,
    headers_note:      "GAS doPost(e) does not expose HTTP headers..."
  }
}
```

### What Diagnostic Mode Never Stores

- Signature values (from body or header)
- `merchant_key`, `api_key`, `signing_secret`, `secret_key`, `password`, `token`
- `payment_account_number`, `card_number`
- Customer email, phone, full name, street address

The `_sanitizeForLog()` function in `DiagnosticService.gs` redacts these fields before any logging.

### Special Case: Scalev `business.test_event`

Scalev sends `business.test_event` when a webhook URL is first saved in the dashboard. This event is handled in `Code.gs` **before** the diagnostic check, ensuring it always returns HTTP 200 regardless of `DIAGNOSTIC_MODE` or `PRODUCTION_BLOCKED` state.

---

## 5. Routing Verification

**Code.gs ROUTER map (verified):**

```javascript
const ROUTER = {
  health:                   handleHealth,
  activate:                 handleActivate,
  validate:                 handleValidate,
  deactivate:               handleDeactivate,
  support_reset_device:     handleSupportResetDevice,
  support_recover_license:  handleSupportRecoverLicense,
  lynk_webhook:             handleLynkWebhook,       // ✅ Phase 4
  scalev_webhook:           handleScalevWebhook      // ✅ Phase 4
};
```

**Webhook routing is confirmed correct:**
- Lynk.id webhook → `POST` with `{"action": "lynk_webhook", ...body fields}`
- Scalev webhook → `POST` with `{"action": "scalev_webhook", ...body fields}` (but see note below)

**Note on Scalev webhook format:**  
Scalev sends the webhook as raw JSON without an `action` field. The router relies on `action` being present in the body. For Scalev, the webhook body must be wrapped or the routing needs adaptation. **This requires verification via diagnostic capture before production deployment.** If Scalev sends raw payload without an `action` field, a separate GAS deployment URL path may be needed, or the router logic must be modified to detect provider-specific payloads.

---

## 6. DEV Deployment Instructions

**Prerequisites:**
- Google account with Apps Script access
- Google Spreadsheet (5 sheets: LICENSES, DEVICES, PAYMENTS, EMAIL_OUTBOX, AUDIT_LOG)
- No existing production webhook URL will be overwritten

**Step 1 — Upload files to Apps Script**

1. Go to https://script.google.com
2. Create a new project named `SEVNT-License-DEV`
3. Upload all `.gs` files from `sevnt-license-system/apps-script/`
   - `Code.gs`
   - `modules/SecurityService.gs`
   - `modules/DatabaseService.gs`
   - `modules/LicenseService.gs`
   - `modules/EmailService.gs`
   - `modules/AuditService.gs`
   - `modules/SupportService.gs`
   - `modules/PaymentNormalizer.gs`
   - `modules/LynkPaymentAdapter.gs`
   - `modules/ScalevPaymentAdapter.gs`
   - `modules/DiagnosticService.gs`
   - `modules/PaymentService.gs`
   - `tests/TestRunner.gs`

**Step 2 — Set Script Properties**

In Apps Script editor → Project Settings → Script Properties, add:

| Property | Value |
|----------|-------|
| `SPREADSHEET_ID` | Your Google Spreadsheet ID |
| `ADMIN_SECRET` | A strong random secret (min 32 chars) |
| `HMAC_SIGNING_KEY` | A strong random HMAC key (min 32 chars) |
| `DIAGNOSTIC_MODE` | `true` |

Do NOT set `PRODUCTION_DEPLOYMENT` for DEV.

**Step 3 — Deploy as Web App**

1. Click Deploy → New Deployment
2. Type: Web App
3. Execute as: Me (your Google account)
4. Who has access: Anyone (required for external webhooks)
5. Click Deploy
6. Copy the deployment URL (format: `https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec`)

**Step 4 — Run initCheck()**

In the Apps Script editor, run `initCheck()` from the function selector. Verify the log shows:
- `INIT_OK: All required Script Properties are set.`
- `INIT_OK: Spreadsheet initialized.`

**Step 5 — Test the DEV endpoint**

Before connecting any payment dashboard, test the endpoint manually:

```bash
# Test GET (health check)
curl https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec

# Expected: {"ok":true,"service":"SEVNT License System","version":"1.0.0"}

# Test POST with unknown action
curl -X POST https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec \
  -H "Content-Type: application/json" \
  -d '{"action":"unknown_xyz"}'

# Expected: {"ok":false,"error":"UNKNOWN_ACTION","message":"Unknown action: unknown_xyz"}

# Test Lynk diagnostic webhook
curl -X POST https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec \
  -H "Content-Type: application/json" \
  -d '{"action":"lynk_webhook","refId":"ORD-TEST-001","amount":"299000","message_id":"MSG-TEST-001","buyer_email":"test@example.com","payment_status":"success"}'

# Expected: {"ok":true,"mode":"diagnostic","message":"Diagnostic capture complete"}

# Test Scalev business.test_event
curl -X POST https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec \
  -H "Content-Type: application/json" \
  -d '{"action":"scalev_webhook","event":"business.test_event","unique_id":"event_test123","timestamp":"2026-11-09T00:00:00Z","data":{}}'

# Expected: {"ok":true,"message":"Test event acknowledged"}
```

**Step 6 — Verify diagnostic capture in AUDIT_LOG**

Open your Google Spreadsheet → AUDIT_LOG sheet.  
After the Lynk test POST, verify a row appears with `event_type = WEBHOOK_DIAGNOSTIC` and `provider = lynk`.

---

## 7. Dashboard Configuration Guides

### 7.1 Lynk.id Webhook Configuration

**⚠️ IMPORTANT:** Lynk.id likely stores ONE webhook URL per account. Before adding a new URL, confirm with the account owner that no existing integration is live and dependent on the current URL.

**Steps (verify menu path in actual dashboard before following):**
1. Log in to your Lynk.id merchant account
2. Navigate to: Settings → Integrations → Webhooks (verify this path in the actual dashboard)
3. Enter the DEV deployment URL for initial testing:
   - The GAS endpoint requires `action=lynk_webhook` to route correctly
   - Lynk.id likely sends raw payload — confirm whether an `action` field can be added, or whether a dedicated GAS URL path is needed
4. After saving, Lynk.id will send a test request (if supported) or you can trigger a test transaction
5. Check AUDIT_LOG for `WEBHOOK_DIAGNOSTIC` entry
6. Record all field names captured — these will confirm or correct the unverified fields above
7. Record the `merchant_key` value shown in the dashboard (needed for `LYNK_MERCHANT_KEY` Script Property once signature verification is implemented)

**Note:** Do not enter the production deployment URL here. Use the DEV URL only for diagnostic testing.

---

### 7.2 Scalev Webhook Configuration

**Dashboard path (VERIFIED from docs):** Settings > Developers > Webhooks

**Requirements:**
- Requires Basic plan or higher
- The webhook signing secret shown here is different from your API key

**Steps:**
1. Log in to Scalev dashboard
2. Navigate to: Settings > Developers > Webhooks
3. Click Add Webhook or similar button
4. Enter the DEV deployment URL
   - Scalev sends raw JSON — confirm how to route to `scalev_webhook` action (see routing note in Section 5)
5. Scalev will immediately send a `business.test_event` to the URL
6. Check response — the endpoint must return `{"ok":true,"message":"Test event acknowledged"}`
7. Verify the `business.test_event` appears in AUDIT_LOG
8. Record the **Webhook Signing Secret** shown in the dashboard (NOT the API key)
   - This will be stored as `SCALEV_WEBHOOK_SIGNING_SECRET` Script Property when signature verification is implemented via middleware

---

## 8. Test Results

### Phase 4.2 Test Suites (25 tests across 4 suites)

**Status: PENDING — requires GAS environment to execute**

The following suites are defined in `TestRunner.gs` and must be run from the Apps Script editor by calling `runAllTests()`:

| Suite | Tests | Coverage |
|-------|-------|---------|
| `testLynkVerifiedFields` | 10 | FIELDS constants, parse(), computeExpectedSignature(), SIGNATURE_BLOCKED |
| `testScalevVerifiedFields` | 8 | EVENTS constants, FULLY_BLOCKED=false, parse(), test_event, computeExpectedSignature() |
| `testDiagnosticService` | 4 | isDiagnosticMode(), getStatus(), capture() safety, no license creation |
| `testDiagnosticSafety` | 7 | business.test_event routing, GET safety, unknown route, empty body, PRODUCTION_BLOCKED, no license_key in response |

**To run tests:**
1. Open the DEV Apps Script project
2. Select `runAllTests` in the function dropdown
3. Click Run
4. Open Execution Log to see results

**Mock tests only — does NOT verify:**
- Live webhook delivery from Lynk.id or Scalev
- Actual header values or signature verification
- Real payment processing

---

## 9. Security Status

| Constraint | Status |
|------------|--------|
| No live license issuance | ✅ PRODUCTION_BLOCKED=true (const — cannot be overridden) |
| No real customer data used | ✅ All tests use mock emails (`@test.sevnt`) |
| No secrets logged | ✅ DiagnosticService._sanitizeForLog() redacts all secret fields |
| No signature assumed from Merchant Key | ✅ Lynk.id: SHA256(amount+refId+message_id+key) is VERIFIED, not assumed |
| API key ≠ webhook secret (Scalev) | ✅ Documented: SCALEV_WEBHOOK_SIGNING_SECRET ≠ API key |
| Lynk.id URL not modified | ✅ No dashboard changes made — URL is owner's decision |
| Diagnostic mode blocked on production | ✅ PRODUCTION_DEPLOYMENT=true blocks DiagnosticService |
| No fabricated deployment URLs | ✅ This report contains no invented DEPLOYMENT_IDs |
| No invented menu paths | ✅ Scalev dashboard path verified from docs; Lynk.id marked as "verify in dashboard" |

---

## 10. What Remains Before Production

| Item | Required Action |
|------|----------------|
| Deploy GAS as Web App (DEV) | Account owner runs Steps 1–4 from Section 6 |
| Test DEV endpoint (GET + POST) | Run curl tests from Section 6 Step 5 |
| Connect Lynk.id dashboard to DEV URL | Account owner — see Section 7.1 |
| Connect Scalev dashboard to DEV URL | Account owner — see Section 7.2 |
| Confirm Scalev `business.test_event` returns 2xx | Verify in AUDIT_LOG after dashboard save |
| Capture real Lynk.id payload structure | Review AUDIT_LOG after test transaction |
| Confirm buyer email field name for Lynk.id | From diagnostic capture result |
| Confirm payment status values for Lynk.id | From diagnostic capture result |
| Implement middleware for signature verification | Cloud Run or Cloud Functions |
| Set `LYNK_MERCHANT_KEY` Script Property | After confirmed from Lynk.id dashboard |
| Set `SCALEV_WEBHOOK_SIGNING_SECRET` Script Property | After confirmed from Scalev dashboard (NOT the API key) |
| Set `PRODUCTION_DEPLOYMENT=true` | Only after: middleware live + signatures verified + test transactions confirmed |
| Set `PRODUCTION_BLOCKED=false` | Only after all of the above |

---

*Phase 4.2 report generated: 2026-11-09. No production data accessed. No live transactions triggered.*
