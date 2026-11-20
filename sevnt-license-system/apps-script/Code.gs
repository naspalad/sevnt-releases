/**
 * SEVNT Google License System — Main Entry Point
 *
 * All POST requests arrive here via doPost(e).
 * Action routing is handled by ROUTER map.
 *
 * SECURITY NOTE:
 * - This Web App runs as USER_DEPLOYING (the Google account owner).
 * - Secrets (ADMIN_SECRET, HMAC_SIGNING_KEY) live only in Script Properties.
 * - Never log secrets, tokens, or license keys in plaintext.
 */

// ─── Constants ────────────────────────────────────────────────────────────────

const VERSION = '1.0.0';

const DEVICE_ROLES = {
  PRIMARY_LAPTOP: 'PRIMARY_LAPTOP',
  MOBILE_COMPANION: 'MOBILE_COMPANION'
};

const LICENSE_STATUS = {
  ACTIVE: 'ACTIVE',
  REVOKED: 'REVOKED'
};

const DEVICE_STATUS = {
  ACTIVE: 'ACTIVE',
  REVOKED: 'REVOKED'
};

const PAYMENT_STATUS = {
  PENDING: 'PENDING',
  PAID: 'PAID',
  FAILED: 'FAILED'
};

const EMAIL_STATUS = {
  PENDING: 'PENDING',
  SENT: 'SENT',
  FAILED: 'FAILED'
};

// Actions that require admin authentication
const ADMIN_ACTIONS = [
  'support_reset_device',
  'support_recover_license',
  'admin_revoke_license',
  'admin_create_license',
  'admin_reset_license_devices',
  'debug_hash'
];

// ─── Router ───────────────────────────────────────────────────────────────────

const ROUTER = {
  health:                 handleHealth,
  activate:               handleActivate,
  validate:               handleValidate,
  deactivate:             handleDeactivate,
  support_reset_device:   handleSupportResetDevice,
  support_recover_license: handleSupportRecoverLicense,
  admin_create_license:         handleAdminCreateLicense,
  admin_revoke_license:         handleAdminRevokeLicense,
  admin_reset_license_devices:  handleAdminResetLicenseDevices,
  debug_hash:                   handleDebugHash,
  lynk_webhook:           handleLynkWebhook,
  scalev_webhook:         handleScalevWebhook
};

// ─── HTTP Handlers ────────────────────────────────────────────────────────────

function doGet(e) {
  return buildJsonResponse({ ok: true, service: 'SEVNT License System', version: VERSION });
}

function doPost(e) {
  try {
    const body = parseRequestBody(e);
    if (!body) return buildErrorResponse('INVALID_REQUEST', 'Request body required', 400);

    const action = body.action || (e && e.parameter && e.parameter.action);
    if (!action) return buildErrorResponse('MISSING_ACTION', 'action field required', 400);

    const handler = ROUTER[action];
    if (!handler) return buildErrorResponse('UNKNOWN_ACTION', 'Unknown action: ' + action, 404);

    // Admin auth gate
    if (ADMIN_ACTIONS.indexOf(action) !== -1) {
      if (!SecurityService.verifyAdminSecret(body.admin_secret)) {
        AuditService.log('UNAUTHORIZED_ADMIN', null, null, 'unknown', 'FAILURE',
          { action: action, ip: getClientIp(e) });
        return buildErrorResponse('UNAUTHORIZED', 'Admin authentication required', 403);
      }
    }

    return handler(body, e);

  } catch (err) {
    Logger.log('SEVNT_LICENSE_ERROR: ' + err.message + '\n' + err.stack);
    return buildErrorResponse('INTERNAL_ERROR', 'Internal server error', 500);
  }
}

// ─── Action Handlers ──────────────────────────────────────────────────────────

function handleHealth(body, e) {
  return buildJsonResponse({
    ok: true,
    version: VERSION,
    timestamp: new Date().toISOString()
  });
}

function handleActivate(body, e) {
  const { license_key, device_role, machine_id, email } = body;
  // device_name opsional — fallback ke email atau machine_id
  const device_name = body.device_name || email || (machine_id ? machine_id.slice(0, 12) : 'unknown');

  if (!license_key) return buildErrorResponse('MISSING_FIELD', 'license_key required', 400);
  if (!device_role) return buildErrorResponse('MISSING_FIELD', 'device_role required', 400);
  if (!machine_id)  return buildErrorResponse('MISSING_FIELD', 'machine_id required', 400);

  const VALID_ROLES = [DEVICE_ROLES.PRIMARY_LAPTOP, DEVICE_ROLES.MOBILE_COMPANION, 'PRIMARY_DEVICE'];
  if (VALID_ROLES.indexOf(device_role) === -1) {
    return buildErrorResponse('INVALID_DEVICE_ROLE', 'device_role tidak valid', 400);
  }
  // Normalisasi PRIMARY_DEVICE → PRIMARY_LAPTOP
  const normalizedRole = device_role === 'PRIMARY_DEVICE' ? DEVICE_ROLES.PRIMARY_LAPTOP : device_role;

  const result = LicenseService.activate({
    license_key,
    device_role: normalizedRole,
    machine_id,
    device_name,
    email: body.email || '',
  });

  if (!result.ok) return buildErrorResponse(result.error, result.message, 400);

  const responsePayload = {
    ok: true,
    device_token: result.device_token,
    device_id:    result.device_id,
    license_id:   result.license_id,
    valid_until:  null, // lifetime license — no expiry
    issued_at:    result.issued_at
  };

  responsePayload.sig = SecurityService.signResponse(responsePayload);
  return buildJsonResponse(responsePayload);
}

function handleValidate(body, e) {
  const { device_token, machine_id } = body;

  if (!device_token) return buildErrorResponse('MISSING_FIELD', 'device_token required', 400);
  if (!machine_id)   return buildErrorResponse('MISSING_FIELD', 'machine_id required', 400);

  const result = LicenseService.validate({ device_token, machine_id });

  if (!result.ok) return buildErrorResponse(result.error, result.message, 400);

  const responsePayload = {
    ok:          true,
    license_id:  result.license_id,
    device_id:   result.device_id,
    device_role: result.device_role,
    valid_until: null,
    issued_at:   new Date().toISOString()
  };

  responsePayload.sig = SecurityService.signResponse(responsePayload);
  return buildJsonResponse(responsePayload);
}

function handleDeactivate(body, e) {
  // User-facing deactivate is NOT supported by design.
  // Deactivation requires Support contact.
  return buildErrorResponse(
    'OPERATION_NOT_PERMITTED',
    'Device deactivation requires contacting SEVNT Support. Please email support@sevntstudio.com.',
    403
  );
}

function handleSupportResetDevice(body, e) {
  const { device_id, reason, ticket_id, operator_email } = body;

  if (!device_id)      return buildErrorResponse('MISSING_FIELD', 'device_id required', 400);
  if (!reason)         return buildErrorResponse('MISSING_FIELD', 'reason required', 400);
  if (!ticket_id)      return buildErrorResponse('MISSING_FIELD', 'ticket_id required', 400);
  if (!operator_email) return buildErrorResponse('MISSING_FIELD', 'operator_email required', 400);

  const result = SupportService.resetDevice({ device_id, reason, ticket_id, operator_email });

  if (!result.ok) return buildErrorResponse(result.error, result.message, 400);
  return buildJsonResponse({ ok: true, message: result.message });
}

function handleSupportRecoverLicense(body, e) {
  const { license_id, reason, ticket_id, operator_email, reissue_key } = body;

  if (!license_id)     return buildErrorResponse('MISSING_FIELD', 'license_id required', 400);
  if (!reason)         return buildErrorResponse('MISSING_FIELD', 'reason required', 400);
  if (!ticket_id)      return buildErrorResponse('MISSING_FIELD', 'ticket_id required', 400);
  if (!operator_email) return buildErrorResponse('MISSING_FIELD', 'operator_email required', 400);

  const result = SupportService.recoverLicense({
    license_id,
    reason,
    ticket_id,
    operator_email,
    reissue_key: reissue_key === true
  });

  if (!result.ok) return buildErrorResponse(result.error, result.message, 400);
  return buildJsonResponse({ ok: true, new_license_key: result.new_license_key || null, message: result.message });
}

function handleAdminCreateLicense(body, e) {
  const email = body.email || '';
  const notes = body.notes || 'created via admin API';

  const license_key = SecurityService.generateLicenseKey();
  const key_hash    = SecurityService.hashLicenseKey(license_key);
  const license_id  = SecurityService.generateId();
  const now         = new Date().toISOString();

  DatabaseService.createLicense({
    license_id:        license_id,
    license_key_hash:  key_hash,
    license_key_prefix: license_key.slice(0, 8),
    customer_email:    email,
    order_id:          'MANUAL-' + license_id.slice(0, 8),
    status:            LICENSE_STATUS.ACTIVE,
    payment_status:    PAYMENT_STATUS.PAID,
    created_at:        now,
    updated_at:        now,
    notes:             notes,
  });

  AuditService.log('ADMIN_CREATE_LICENSE', license_id, null, 'admin', 'SUCCESS', { email });

  return buildJsonResponse({
    ok:          true,
    license_key: license_key,
    license_id:  license_id,
    email:       email,
    created_at:  now,
  });
}

function handleDebugHash(body, e) {
  const license_key = body.license_key || '';
  if (!license_key) return buildErrorResponse('MISSING_FIELD', 'license_key required', 400);

  const computed_hash = SecurityService.hashLicenseKey(license_key);

  // Read LICENSES sheet directly to compare hashes
  const ss = SpreadsheetApp.openById(
    PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID')
  );
  const sheet = ss.getSheetByName('LICENSES');
  const lastRow = sheet ? sheet.getLastRow() : 0;
  let stored_hashes = [];
  if (lastRow >= 2) {
    const values = sheet.getRange(2, 2, lastRow - 1, 1).getValues(); // col B = license_key_hash
    stored_hashes = values.map(function(r) { return String(r[0]); });
  }
  const found = stored_hashes.indexOf(computed_hash) !== -1;

  return buildJsonResponse({
    ok: true,
    input_key: license_key,
    computed_hash: computed_hash,
    stored_hashes: stored_hashes,
    found: found,
    row_count: lastRow - 1
  });
}

function handleAdminRevokeLicense(body, e) {
  const { license_id } = body;
  if (!license_id) return buildErrorResponse('MISSING_FIELD', 'license_id required', 400);

  const result = SupportService.revokeLicense({ license_id, reason: body.reason || 'admin revoke' });
  if (!result.ok) return buildErrorResponse(result.error, result.message, 400);
  return buildJsonResponse({ ok: true, message: result.message });
}

function handleAdminResetLicenseDevices(body, e) {
  const license_key = body.license_key || '';
  if (!license_key) return buildErrorResponse('MISSING_FIELD', 'license_key required', 400);

  const keyHash = SecurityService.hashLicenseKey(license_key);
  const license = DatabaseService.findLicenseByKeyHash(keyHash);
  if (!license) return buildErrorResponse('LICENSE_NOT_FOUND', 'License not found', 404);

  const devices = DatabaseService.findDevicesByLicenseId(license.license_id);
  const now = new Date().toISOString();
  let revoked = 0;
  devices.forEach(function(d) {
    if (d.status === 'ACTIVE') {
      DatabaseService.updateDevice(d._rowIndex, {
        status: 'REVOKED',
        revoked_at: now,
        revocation_reason: body.reason || 'admin_reset'
      });
      revoked++;
    }
  });

  AuditService.log('ADMIN_RESET_DEVICES', license.license_id, null, 'admin', 'SUCCESS',
    { revoked_count: revoked, reason: body.reason || 'admin_reset' });

  return buildJsonResponse({ ok: true, license_id: license.license_id, revoked_count: revoked });
}

function handleLynkWebhook(body, e) {
  // Unwrap Cloudflare Worker proxy envelope: {action, payload, _lynk_proxy} → actual Lynk body
  const lynkBody   = (body && body.action === 'lynk_webhook' && body.payload) ? body.payload : body;
  const proxyMeta  = (body && body._lynk_proxy) ? body._lynk_proxy : null;

  // Diagnostic mode: capture structure, do not process payment
  if (DiagnosticService.isDiagnosticMode()) {
    const rawBody = (e && e.postData && e.postData.contents) ? e.postData.contents : '';
    const result  = DiagnosticService.capture('lynk', lynkBody, e, rawBody);
    // Always return 2xx in diagnostic mode so Lynk.id considers delivery successful
    return buildJsonResponse({
      ok: true,
      mode: 'diagnostic',
      message: result.message || 'Diagnostic capture complete'
    });
  }

  const result = PaymentService.handleLynkWebhook(lynkBody, e, proxyMeta);
  if (!result.ok) return buildErrorResponse(result.error, result.message, 400);
  return buildJsonResponse({ ok: true, message: result.message });
}

function handleScalevWebhook(body, e) {
  const rawBody = (e && e.postData && e.postData.contents) ? e.postData.contents : '';

  // Scalev sends business.test_event when webhook URL is first saved — MUST return 2xx
  // Handle before diagnostic check so test event always passes
  if (body && body.event === 'business.test_event') {
    Logger.log('handleScalevWebhook: Received business.test_event — returning ACK');
    AuditService.log('WEBHOOK_DIAGNOSTIC', null, null, 'system', 'SUCCESS',
      { provider: 'scalev', event: 'business.test_event', unique_id: body.unique_id || '' });
    return buildJsonResponse({ ok: true, message: 'Test event acknowledged' });
  }

  // Diagnostic mode: capture structure, do not process payment
  if (DiagnosticService.isDiagnosticMode()) {
    const result = DiagnosticService.capture('scalev', body, e, rawBody);
    return buildJsonResponse({
      ok: true,
      mode: 'diagnostic',
      message: result.message || 'Diagnostic capture complete'
    });
  }

  const result = PaymentService.handleScalevWebhook(body, e);
  if (!result.ok) return buildErrorResponse(result.error, result.message, 400);
  return buildJsonResponse({ ok: true, message: result.message });
}

// ─── Dev / Test Helpers ───────────────────────────────────────────────────────

/**
 * Test: send license delivery email to any address.
 * Run manually from GAS editor (▶ Run button).
 *
 * Edit TEST_TO and TEST_LICENSE_KEY before running.
 */
function testSendLicenseEmail() {
  var TEST_TO       = 'your-test-email@example.com'; // ← ganti ke email kamu
  var TEST_KEY      = 'JWUR9-MRE5B-75ELW-5CVED-C5PFQ'; // ← license key dari lisensi test
  var TEST_NAME     = 'Test User';

  MailApp.sendEmail({
    to:       TEST_TO,
    subject:  'Your SOCL Visuals Studio License Key',
    htmlBody: EmailService._renderTemplatePublic('LICENSE_DELIVERY', { license_key: TEST_KEY, customer_name: TEST_NAME }, TEST_TO).html,
    body:     'License key: ' + TEST_KEY
  });

  Logger.log('Test email sent to: ' + TEST_TO);
}

/**
 * Process email outbox manually (instead of waiting for trigger).
 * Run from GAS editor to send all PENDING emails now.
 */
function runEmailQueue() {
  EmailService.processEmailQueue();
  Logger.log('Email queue processed.');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseRequestBody(e) {
  try {
    if (e.postData && e.postData.contents) {
      return JSON.parse(e.postData.contents);
    }
    // Also accept form params (for testing via URL)
    if (e.parameter && e.parameter.body) {
      return JSON.parse(e.parameter.body);
    }
    return null;
  } catch (err) {
    return null;
  }
}

function buildJsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function buildErrorResponse(code, message, statusHint) {
  // Note: GAS Web Apps cannot set HTTP status codes.
  // Clients must check response.ok === false.
  return buildJsonResponse({ ok: false, error: code, message: message });
}

function getClientIp(e) {
  try {
    return e && e.parameter && e.parameter.userIP ? e.parameter.userIP : 'unknown';
  } catch (err) {
    return 'unknown';
  }
}

// ─── Initialization ───────────────────────────────────────────────────────────

/**
 * Run once after deployment to verify Script Properties are configured.
 * Called manually from Apps Script editor.
 */
function initCheck() {
  const props = PropertiesService.getScriptProperties();
  const required = ['ADMIN_SECRET', 'HMAC_SIGNING_KEY', 'SPREADSHEET_ID'];
  const missing = required.filter(k => !props.getProperty(k));

  if (missing.length > 0) {
    Logger.log('INIT_FAIL: Missing Script Properties: ' + missing.join(', '));
    Logger.log('Run setupScriptProperties() to configure them.');
    return false;
  }

  Logger.log('INIT_OK: All required Script Properties are set.');
  DatabaseService.initSpreadsheet();
  Logger.log('INIT_OK: Spreadsheet initialized.');
  return true;
}

/**
 * One-time setup of Script Properties.
 * Fill in real values before running.
 * RUN ONLY ONCE — from Apps Script editor.
 */
function setupScriptProperties() {
  const props = PropertiesService.getScriptProperties();

  // Replace these placeholder values with real ones
  // NEVER commit real values to source control
  props.setProperties({
    'ADMIN_SECRET':     'REPLACE_WITH_STRONG_RANDOM_SECRET_MIN_32_CHARS',
    'HMAC_SIGNING_KEY': 'REPLACE_WITH_STRONG_RANDOM_HMAC_KEY_MIN_32_CHARS',
    'SPREADSHEET_ID':   'REPLACE_WITH_YOUR_GOOGLE_SPREADSHEET_ID'
  }, false); // false = merge, don't delete existing

  Logger.log('Script Properties set. IMPORTANT: Replace placeholder values before production use.');
}
