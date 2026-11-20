# SEVNT License System

Google Apps Script + Google Spreadsheet license backend for SEVNT Studio.

## Architecture

```
Lynk.id Payment   ─┐
                    ├→ Adapter → NormalizedTransaction → PaymentService → License → Email
Scalev Payment    ─┘

SEVNT Studio (Electron)  →  POST /activate  →  Device Token issued
                         →  POST /validate  →  Token verified per request
```

## Status

| Phase | Status | Notes |
|-------|--------|-------|
| Phase 1 — Foundation | ✅ DONE | License, device, support, audit, email queue |
| Phase 4 — Dual Provider Architecture | 🚫 BLOCKED | Lynk.id: SIGNATURE_BLOCKED; Scalev: FULLY_BLOCKED (docs inaccessible) |
| Phase 2 — Payment Live | 🚫 BLOCKED | Requires Phase 4 unblock |
| Phase 3 — Security Hardening | 📋 PLANNED | Ed25519, clock detection |
| Phase 5 — Deployment | ⏳ PENDING APPROVAL | See docs/DEPLOYMENT.md |
| Phase 6 — SEVNT Integration | ⏳ PENDING | After Phase 5 |

## Files

```
sevnt-license-system/
├── apps-script/
│   ├── Code.gs                    Main router + HTTP handlers
│   ├── appsscript.json            GAS manifest
│   ├── modules/
│   │   ├── SecurityService.gs     Crypto, tokens, signing
│   │   ├── DatabaseService.gs     Spreadsheet CRUD
│   │   ├── LicenseService.gs      Activate + validate
│   │   ├── DeviceService.gs       Device revocation
│   │   ├── SupportService.gs      Admin reset + recovery
│   │   ├── AuditService.gs        Immutable audit log
│   │   ├── EmailService.gs        Email outbox + templates
│   │   ├── PaymentNormalizer.gs   Provider-agnostic transaction contract (Phase 4)
│   │   ├── LynkPaymentAdapter.gs  Lynk.id webhook adapter (SIGNATURE_BLOCKED)
│   │   ├── ScalevPaymentAdapter.gs Scalev webhook adapter (FULLY_BLOCKED)
│   │   └── PaymentService.gs      Provider-agnostic payment processor (Phase 4)
│   └── tests/
│       └── TestRunner.gs          Full test harness ~77 tests (run from GAS editor)
└── docs/
    ├── API_CONTRACT.md
    ├── DATABASE_SCHEMA.md
    ├── SECURITY.md
    └── DEPLOYMENT.md
```

## Quick Start (Dev)

1. Create Google Spreadsheet → copy ID
2. Create Apps Script project → paste all `.gs` files
3. Set Script Properties: `ADMIN_SECRET`, `HMAC_SIGNING_KEY`, `SPREADSHEET_ID`
4. Run `initCheck()` → verify INIT_OK
5. Run `runAllTests()` → verify all PASS
6. Deploy as Web App
7. Update `src/sevnt-config.js` with Web App URL

## Business Rules

- Lifetime license, no subscription
- 1 `PRIMARY_LAPTOP` + 1 `MOBILE_COMPANION` per license
- Mobile requires laptop to be activated first
- Device deactivation = SUPPORT ONLY (no self-service)
- SOCL continues running until Phase 5 cutover is approved
