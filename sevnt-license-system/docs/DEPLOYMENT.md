# SEVNT License System — Deployment Guide

**DO NOT deploy to production without owner approval.**

---

## Prerequisites

- [ ] Google account with Google Workspace or personal Gmail
- [ ] Access to Google Apps Script (script.google.com)
- [ ] Access to Google Drive (for Spreadsheet)

---

## Step 1: Create the Google Spreadsheet

1. Go to Google Drive → New → Google Sheets
2. Name it: `SEVNT License DB` (or any name — ID matters, not name)
3. Copy the Spreadsheet ID from the URL:
   `https://docs.google.com/spreadsheets/d/SPREADSHEET_ID_HERE/edit`
4. Keep the spreadsheet private (share with no one — it contains license data)

---

## Step 2: Create the Apps Script Project

1. Go to [script.google.com](https://script.google.com) → New Project
2. Name it: `SEVNT License System`
3. Copy all `.gs` files from `apps-script/` to the editor:
   - `Code.gs` (rename the default "Code.gs" that Apps Script creates)
   - Create new files for each module in `modules/`:
     - `SecurityService.gs`
     - `DatabaseService.gs`
     - `LicenseService.gs`
     - `DeviceService.gs`
     - `SupportService.gs`
     - `AuditService.gs`
     - `EmailService.gs`
     - `PaymentService.gs`
     - `PaymentNormalizer.gs`
     - `LynkPaymentAdapter.gs`
     - `ScalevPaymentAdapter.gs`
     - `DiagnosticService.gs`
   - Create `tests/TestRunner.gs`
4. Copy `appsscript.json` content to the manifest (Project Settings → Show "appsscript.json")

**File order does not matter in GAS V8** — all files share the same global scope.

---

## Step 3: Configure Script Properties

1. In Apps Script editor: Project Settings (gear icon) → Script Properties
2. Add the following properties manually (**never commit real values**):

| Property Key | Value |
|-------------|-------|
| `ADMIN_SECRET` | Generate a strong random string (min 32 chars, e.g. `openssl rand -hex 32`) |
| `HMAC_SIGNING_KEY` | Generate a different strong random string |
| `SPREADSHEET_ID` | The ID from Step 1 |

**OR** run `setupScriptProperties()` from the editor and then update the placeholder values.

---

## Step 4: Initialize the Spreadsheet

1. In the Apps Script editor, select function: `initCheck`
2. Click Run
3. Authorize the required OAuth scopes when prompted
4. Check the Execution Log — should say `INIT_OK`

This creates all 5 sheets with correct headers.

---

## Step 5: Run Tests

1. Select function: `runAllTests`
2. Click Run
3. View → Execution Log
4. All tests should show `[PASS]`
5. Final line: `TEST RESULTS: X/X passed, 0 failed`

**Do NOT proceed if any test fails.**

---

## Step 6: Deploy as Web App

1. Deploy → New Deployment
2. Type: Web App
3. Description: `SEVNT License API v1`
4. Execute as: `Me (your Google account)`
5. Who has access: `Anyone` (required for client requests without OAuth)
6. Click Deploy
7. Copy the Web App URL — this is your `LICENSE_API_ENDPOINT`

---

## Step 7: Configure Email Trigger

For the email outbox processor:

1. Triggers (clock icon in left panel) → Add Trigger
2. Function: `processEmailQueue`
3. Event source: Time-driven
4. Type: Minutes timer
5. Interval: Every 5 minutes
6. Save

---

## Step 8: Update SEVNT Client Config

In `src/sevnt-config.js`, update the placeholder:

```javascript
LICENSE_API_ENDPOINT: process.env.SEVNT_LICENSE_API_URL ||
  'https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec'
```

Set `SEVNT_SKIP_SIG_VERIFY=true` in development until Phase 3 (Ed25519) is implemented.

---

## Rollback

To rollback: deploy a previous version from Deploy → Manage Deployments → select previous version.

## Production Checklist

- [ ] All tests pass
- [ ] Script Properties set with real (non-placeholder) secrets
- [ ] Spreadsheet initialized with 5 sheets
- [ ] Email trigger configured
- [ ] Web App URL noted and secured
- [ ] Admin secret stored safely (password manager)
- [ ] SOCL system still running in parallel (no cutover yet)
- [ ] Owner has approved deployment
