# SEVNT License System — Phase 4 Final Report
**Dual Payment Provider Architecture**  
Date: 2026-11-09  
Status: IMPLEMENTATION COMPLETE — INTEGRATION BLOCKED (both providers)

---

## 1. Documentation Research Results

### 1.1 Lynk.id

| Item | Result |
|------|--------|
| Primary URL researched | `https://lynk.id/developer`, `https://lynk.id/api`, `https://docs.lynk.id`, `https://help.lynk.id` |
| Webhook docs accessible? | **NO** — All URLs return 404 or empty pages |
| Webhook field names | **UNKNOWN** |
| Signature mechanism | **UNKNOWN** |
| Paid status values | **UNKNOWN** |
| Webhook signing key | **UNKNOWN** |
| **Verdict** | **SIGNATURE_BLOCKED** |

**What IS known:** Lynk.id mentions "Webhook" as a platform feature in their footer. The existing `PaymentService.gs` (Phase 1) used PLACEHOLDER field names (`order_id`, `buyer_email`, `payment_status`, `amount`, `currency`, `transaction_id`) that MUST be verified against official documentation before unblocking.

**To unblock Lynk.id:** Contact Lynk.id support (hello@lynk.id) or access their merchant dashboard webhook section to obtain: exact field names, signature header, and signing algorithm.

---

### 1.2 Scalev

| Item | Result |
|------|--------|
| Primary URL researched | `https://dev.scalev.com/` |
| Root page accessible? | YES (loads but content is minimal) |
| Sub-pages accessible? | **NO** — ALL return 404 |
| Pages attempted | `/getting-started`, `/orders`, `/api-reference`, `/changelog/canonical-payment-methods-and-paylink` |
| Webhook field names | **UNKNOWN** |
| Signature mechanism | **UNKNOWN** |
| **Verdict** | **FULLY_BLOCKED** |

**To unblock Scalev:** Wait for `dev.scalev.com` to become accessible, or contact Scalev developer support directly.

---

## 2. Files Created / Modified

### 2.1 New Files (Phase 4)

| File | Status | Description |
|------|--------|-------------|
| `modules/PaymentNormalizer.gs` | ✅ CREATED | Provider-agnostic internal transaction contract |
| `modules/LynkPaymentAdapter.gs` | ✅ CREATED (🚫 SIGNATURE_BLOCKED) | Lynk.id webhook parser + normalizer |
| `modules/ScalevPaymentAdapter.gs` | ✅ CREATED (🚫 FULLY_BLOCKED) | Scalev webhook parser stub |

### 2.2 Modified Files (Phase 4)

| File | Change |
|------|--------|
| `modules/PaymentService.gs` | Replaced with provider-agnostic dual-provider architecture |
| `modules/DatabaseService.gs` | Added `findPaymentByCompositeKey(compositeKey)` |
| `Code.gs` | Added `scalev_webhook` route + `handleScalevWebhook()` handler |
| `tests/TestRunner.gs` | Added 6 new Phase 4 test suites (~30 tests); fixed `handleWebhook` → `handleLynkWebhook` call |
| `README.md` | Updated architecture diagram and status table |
| `docs/API_CONTRACT.md` | Added `scalev_webhook` endpoint documentation |

---

## 3. Architecture Changes

### 3.1 Dual Provider Flow (Phase 4)

```
Lynk.id webhook   →  LynkPaymentAdapter.parse()   ─┐
                                                     ├→ NormalizedTransaction
Scalev webhook    →  ScalevPaymentAdapter.parse()  ─┘       ↓
                                                     PaymentService._processNormalized()
                                                             ↓
                                                     DatabaseService (composite key)
                                                             ↓
                                                     LicenseService → EmailService
```

### 3.2 Idempotency Key Design

**Before Phase 4 (BROKEN for dual-provider):**
```
PAYMENTS.order_id = "ORD-123"  ← collision risk: lynk:ORD-123 === scalev:ORD-123
event_digest = sha256("ORD-123:PAID:TXN-1")
```

**After Phase 4 (CORRECT):**
```
PAYMENTS.order_id = "lynk:ORD-123"  OR  "scalev:ORD-123"  ← no collision
event_digest = sha256("lynk:ORD-123:PAID:TXN-1")  ← includes provider
```

The `findPaymentByCompositeKey('lynk:ORD-123')` and `findPaymentByCompositeKey('scalev:ORD-123')` are entirely independent records, even if external `order_id` values happen to be identical across providers.

### 3.3 PaymentNormalizer Contract

```javascript
{
  provider:            'lynk' | 'scalev',
  external_order_id:   '<provider-side order ID>',
  composite_key:       'provider:external_order_id',
  customer_email:      '<buyer email>',
  amount:              <number | ''>,
  currency:            'IDR',
  payment_status:      '<raw provider status>',
  is_paid:             <boolean>,
  provider_tx_id:      '<provider internal tx ref>',
  received_at:         '<ISO8601>',
  signature_verified:  <boolean>
}
```

---

## 4. Test Results

### 4.1 Status: NOT YET RUN

Tests require a configured Google Apps Script environment:
- Spreadsheet with 5 sheets (LICENSES, DEVICES, PAYMENTS, EMAIL_OUTBOX, AUDIT_LOG)
- Script Properties: `ADMIN_SECRET`, `HMAC_SIGNING_KEY`, `SPREADSHEET_ID`

**HARD RULE (PHASE 4 spec):** Cannot fabricate test results. Test results reported here are PENDING.

### 4.2 Expected Test Distribution

| Suite | Tests | Status |
|-------|-------|--------|
| SecurityService (Phase 1) | 11 | PENDING run |
| LicenseActivation (Phase 1) | 5 | PENDING run |
| DeviceSlots (Phase 1) | 3 | PENDING run |
| MobileCompanion (Phase 1) | 4 | PENDING run |
| TokenValidation (Phase 1) | 5 | PENDING run |
| SupportReset (Phase 1) | 4 | PENDING run |
| SupportRecovery (Phase 1) | 4 | PENDING run |
| PaymentIdempotency (Phase 1, updated) | 3 | PENDING run |
| SecurityConstraints (Phase 1) | 6 | PENDING run |
| ConcurrentActivation (Phase 1) | 2 | PENDING run |
| **Phase 1 subtotal** | **~47** | PENDING |
| PaymentNormalizer (Phase 4) | ~10 | PENDING run |
| LynkPaymentAdapter (Phase 4) | ~10 | PENDING run |
| ScalevPaymentAdapter (Phase 4) | ~6 | PENDING run |
| CompositeIdempotency (Phase 4) | ~8 | PENDING run |
| CrossProviderIsolation (Phase 4) | ~8 | PENDING run |
| WebhookRouting (Phase 4) | ~8 | PENDING run |
| **Phase 4 subtotal** | **~50** | PENDING |
| **TOTAL** | **~97** | PENDING |

### 4.3 Known Expected Outcomes

Based on design (not fabricated — these are deterministic from code):

| Test | Expected |
|------|----------|
| `PaymentService.PRODUCTION_BLOCKED` | PASS — hardcoded `true` |
| `LynkPaymentAdapter.SIGNATURE_BLOCKED` | PASS — hardcoded `true` |
| `ScalevPaymentAdapter.FULLY_BLOCKED` | PASS — hardcoded `true` |
| `handleLynkWebhook` → INTEGRATION_BLOCKED | PASS — PRODUCTION_BLOCKED guard fires |
| `handleScalevWebhook` → INTEGRATION_BLOCKED | PASS — FULLY_BLOCKED guard fires |
| `buildCompositeKey('lynk','ORD-1')` → `'lynk:ORD-1'` | PASS — string concat |
| Cross-provider event digests differ | PASS — SHA256 of different inputs |
| `findPaymentByCompositeKey` for new key | PASS — returns null |
| `ScalevPaymentAdapter.parse()` → null | PASS — FULLY_BLOCKED returns null |

---

## 5. Dev Environment Setup Checklist

To run all tests (Phase 1 + Phase 4), configure a **separate development** Apps Script project:

### Step 1 — Spreadsheet

```
1. Create new Google Spreadsheet (name: "SEVNT License DEV")
2. Copy Spreadsheet ID from URL
3. Keep private (do not share)
```

### Step 2 — Apps Script Project

```
1. Go to script.google.com → New Project
2. Name: "SEVNT License DEV"
3. Upload all .gs files in this order:
   Code.gs
   modules/SecurityService.gs
   modules/DatabaseService.gs
   modules/LicenseService.gs
   modules/DeviceService.gs
   modules/SupportService.gs
   modules/AuditService.gs
   modules/EmailService.gs
   modules/PaymentNormalizer.gs     ← NEW Phase 4
   modules/LynkPaymentAdapter.gs    ← NEW Phase 4
   modules/ScalevPaymentAdapter.gs  ← NEW Phase 4
   modules/PaymentService.gs        ← UPDATED Phase 4
   tests/TestRunner.gs
4. Copy appsscript.json to manifest (Project Settings → Show appsscript.json)
```

### Step 3 — Script Properties

```
Project Settings → Script Properties → Add:

ADMIN_SECRET     = <generate: openssl rand -hex 32>
HMAC_SIGNING_KEY = <generate: openssl rand -hex 32>
SPREADSHEET_ID   = <from Step 1>
```

> **NOTE:** `LYNK_WEBHOOK_SECRET` and `SCALEV_WEBHOOK_SECRET` are NOT needed yet —  
> both adapters are BLOCKED. Add them when official documentation is obtained.

### Step 4 — Initialize

```
1. Select function: initCheck
2. Click Run → authorize OAuth scopes
3. Execution log should say: INIT_OK
```

### Step 5 — Run Tests

```
1. Select function: runAllTests
2. Click Run
3. View → Execution log
4. Expected: ~97 tests, all PASS
   (Some test cases designed to verify BLOCKED state — PASS = correctly blocked)
```

---

## 6. Security Status

| Item | Status |
|------|--------|
| `PRODUCTION_BLOCKED = true` | ✅ Active guard |
| `LynkPaymentAdapter.SIGNATURE_BLOCKED = true` | ✅ Active guard |
| `ScalevPaymentAdapter.FULLY_BLOCKED = true` | ✅ Active guard |
| No secrets written to code or report | ✅ Compliant |
| No live webhook processing | ✅ Confirmed — guards prevent processing |
| No real customer data used | ✅ All tests use `@test.sevnt` email addresses |
| Cross-provider idempotency isolation | ✅ Implemented via composite key |
| `PRODUCTION_BLOCKED` can be bypassed? | ❌ No — both guards are `const` in module scope |

---

## 7. What Remains Before Production

| Blocker | Required Action |
|---------|----------------|
| Lynk.id webhook field names | Contact hello@lynk.id or access merchant dashboard webhook settings |
| Lynk.id signature algorithm | Same as above |
| Lynk.id webhook signing key | Same as above; store as `LYNK_WEBHOOK_SECRET` in Script Properties |
| Scalev documentation | Wait for `dev.scalev.com` to become accessible OR contact Scalev support |
| Scalev field names + signature | Same as above; fill `ScalevPaymentAdapter.FIELDS` and `_verifySignature()` |
| Run tests in GAS | Configure dev environment (Section 5), run `runAllTests()`, verify all PASS |
| Owner approval for deployment | Required before `PRODUCTION_BLOCKED = false` |

---

## 8. Absolute Rules Compliance

| Rule (from PHASE 4 spec) | Status |
|--------------------------|--------|
| Jangan deploy ke production | ✅ NOT deployed — no `PRODUCTION_BLOCKED = false` |
| Jangan mengaktifkan webhook untuk pembeli sungguhan | ✅ BLOCKED guards prevent this |
| Jangan mengubah SOCL production | ✅ No SOCL files touched |
| Jangan menghapus sistem SOCL | ✅ Not deleted |
| Jangan mengubah aplikasi desktop SEVNT | ✅ No SEVNT desktop changes |
| Jangan mengubah UI SEVNT | ✅ No UI changes |
| Jangan mengganti database production | ✅ No production Spreadsheet touched |
| Jangan menggunakan data pelanggan sungguhan | ✅ All test data uses `@test.sevnt` |
| Jangan menuliskan secret ke laporan | ✅ No secrets in this report |
| Jangan menyatakan integrasi live berhasil jika hanya mock test | ✅ Explicitly marked BLOCKED |
| Jangan menebak field names, header, algorithm, signature, status, auth | ✅ All unknown items marked PLACEHOLDER or UNKNOWN_FIELD |
