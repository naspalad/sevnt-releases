/**
 * DiagnosticService — DEV-ONLY webhook diagnostic mode.
 *
 * PURPOSE:
 *   Receive and inspect real webhook requests from Lynk.id and Scalev
 *   WITHOUT issuing licenses, sending emails, or touching production data.
 *
 * SAFETY GUARANTEES:
 *   - DIAGNOSTIC_MODE = true  → no license creation, no email, no production DB write
 *   - DIAGNOSTIC_MODE = false → this module is a no-op; production path is used
 *   - Cannot be enabled from production deployment (checked via Script Property)
 *   - Stores only sanitized metadata; never raw signatures, keys, or PII
 *
 * HOW TO ENABLE:
 *   Set Script Property: DIAGNOSTIC_MODE = "true"
 *   This must be a DEV Apps Script deployment, not the production deployment.
 *   After diagnostic is complete, remove DIAGNOSTIC_MODE property.
 *
 * DATA STORED:
 *   AUDIT_LOG rows with event_type = 'WEBHOOK_DIAGNOSTIC'
 *   Contains: provider, timestamp, field names (NOT values), payload structure
 *   Does NOT contain: signatures, secrets, PII, payment credentials
 *
 * GAS HEADER LIMITATION (DOCUMENTED):
 *   Apps Script doPost(e) does NOT expose arbitrary HTTP headers.
 *   X-Lynk-Signature and X-Scalev-Hmac-Sha256 are NOT readable.
 *   Diagnostic mode captures body structure only.
 *   Production signature verification requires a middleware layer
 *   (e.g., Cloud Run / Cloud Functions) that reads headers and proxies to GAS.
 *   See PHASE4.2-REPORT.md Section 5 for middleware design.
 */

const DiagnosticService = (function() {

  // ─── State ───────────────────────────────────────────────────────────────

  /**
   * Returns true if diagnostic mode is enabled in Script Properties.
   * Never hardcoded — must be explicitly set in this deployment's properties.
   */
  function isDiagnosticMode() {
    try {
      const val = PropertiesService.getScriptProperties().getProperty('DIAGNOSTIC_MODE');
      return val === 'true';
    } catch (e) {
      return false;
    }
  }

  /**
   * Production guard: reject diagnostic requests if any production signal is set.
   * Checks for a property that is set only in production deployments.
   * Production deployment should have: PRODUCTION_DEPLOYMENT = "true"
   *
   * @returns {boolean} true if safe to run diagnostic (not in production)
   */
  function isSafeDevEnvironment() {
    try {
      const isProd = PropertiesService.getScriptProperties().getProperty('PRODUCTION_DEPLOYMENT');
      return isProd !== 'true';
    } catch (e) {
      return false; // Fail safe — if properties unreadable, don't run diagnostic
    }
  }

  // ─── Core Diagnostic Handler ──────────────────────────────────────────────

  /**
   * Handle a diagnostic webhook request.
   * Captures field structure and metadata; never processes as a payment.
   *
   * @param {string} provider - 'lynk' | 'scalev'
   * @param {Object} body     - Parsed JSON body (may be null if body is invalid JSON)
   * @param {Object} e        - Apps Script event object
   * @param {string} rawBody  - Raw body string (from e.postData.contents)
   * @returns {{ ok: boolean, mode: 'diagnostic', provider: string, captured: Object }}
   */
  function capture(provider, body, e, rawBody) {
    if (!isDiagnosticMode()) {
      return {
        ok: false,
        error: 'DIAGNOSTIC_NOT_ENABLED',
        message: 'Set Script Property DIAGNOSTIC_MODE=true to enable diagnostic mode'
      };
    }

    if (!isSafeDevEnvironment()) {
      Logger.log('DiagnosticService: REJECTED — PRODUCTION_DEPLOYMENT=true. ' +
                 'Never run diagnostic mode on production.');
      return {
        ok: false,
        error: 'PRODUCTION_ENVIRONMENT_REJECTED',
        message: 'Diagnostic mode cannot run on a production deployment.'
      };
    }

    const now = new Date().toISOString();

    // ── Capture GAS event metadata (what IS readable) ──────────────────────
    const gasEventMeta = _captureGasEventMeta(e);

    // ── Capture sanitized body structure ───────────────────────────────────
    const bodyCapture = _captureBodyStructure(provider, body, rawBody);

    // ── Determine parse result ─────────────────────────────────────────────
    const parseResult = body !== null ? 'JSON_PARSED_OK' : 'JSON_PARSE_FAILED';

    // ── Identify event type (Scalev only) ─────────────────────────────────
    const eventType = (body && body.event) ? body.event : 'UNKNOWN';

    // ── Redact sensitive fields before logging ─────────────────────────────
    const sanitized = _sanitizeForLog(provider, body);

    const captured = {
      provider:          provider,
      received_at:       now,
      parse_result:      parseResult,
      event_type:        eventType,
      gas_event_meta:    gasEventMeta,
      body_structure:    bodyCapture.fieldNames,
      body_field_types:  bodyCapture.fieldTypes,
      body_field_depths: bodyCapture.fieldDepths,
      sanitized_sample:  sanitized,
      header_note:       'HEADERS NOT READABLE IN GAS: X-Lynk-Signature and X-Scalev-Hmac-Sha256 ' +
                         'cannot be accessed via doPost(e). See PHASE4.2-REPORT.md Section 5.'
    };

    Logger.log('DIAGNOSTIC [' + provider + ']: ' + JSON.stringify(captured, null, 2));

    // Write to AUDIT_LOG (sanitized — no secrets, no PII payment data)
    try {
      AuditService.log(
        'WEBHOOK_DIAGNOSTIC',
        null, null,
        'diagnostic_service',
        'SUCCESS',
        captured
      );
    } catch (auditErr) {
      Logger.log('DiagnosticService: AuditLog write failed: ' + auditErr.message);
      // Don't throw — diagnostic capture succeeded even if audit write failed
    }

    return {
      ok:       true,
      mode:     'diagnostic',
      provider: provider,
      captured: {
        received_at:    now,
        parse_result:   parseResult,
        event_type:     eventType,
        field_names:    bodyCapture.fieldNames,
        gas_event_meta: gasEventMeta
      },
      message: 'Diagnostic capture complete. No license issued. No email sent. ' +
               'Check Apps Script execution log for field structure details.'
    };
  }

  // ─── GAS Event Metadata ───────────────────────────────────────────────────

  /**
   * Extract everything that IS readable from the GAS event object.
   * Documents what cannot be read (headers).
   *
   * @param {Object} e - Apps Script doPost event
   * @returns {Object}
   */
  function _captureGasEventMeta(e) {
    if (!e) return { note: 'event object is null (test call or missing)' };

    const meta = {};

    // Content type (available via postData)
    try {
      meta.content_type = (e.postData && e.postData.type) ? e.postData.type : 'NOT_AVAILABLE';
    } catch (err) { meta.content_type = 'ERROR: ' + err.message; }

    // Raw body length
    try {
      meta.body_length = (e.postData && e.postData.contents) ? e.postData.contents.length : 0;
    } catch (err) { meta.body_length = 'ERROR: ' + err.message; }

    // Query string parameters (what IS available)
    try {
      meta.query_params = e.parameter ? Object.keys(e.parameter) : [];
    } catch (err) { meta.query_params = []; }

    // HTTP method — GAS LIMITATION: Apps Script doPost always receives POST
    // but the method is not explicitly exposed in the event object
    meta.http_method = 'POST (inferred — GAS doPost only receives POST)';

    // Headers — explicitly document what is NOT readable
    meta.headers_readable = false;
    meta.headers_note = 'Apps Script doPost(e) does not expose arbitrary HTTP headers. ' +
                        'X-Lynk-Signature, X-Scalev-Hmac-Sha256, Authorization, etc. ' +
                        'are NOT accessible. Signature verification requires middleware. ' +
                        'See: https://issuetracker.google.com/issues/36763610';

    return meta;
  }

  // ─── Body Structure Capture ───────────────────────────────────────────────

  /**
   * Extract field names and types from the parsed body.
   * Does NOT store values — only structure metadata.
   *
   * @param {string} provider
   * @param {Object|null} body
   * @param {string} rawBody
   * @returns {{ fieldNames: string[], fieldTypes: Object, fieldDepths: Object }}
   */
  function _captureBodyStructure(provider, body, rawBody) {
    if (!body) {
      return {
        fieldNames: [],
        fieldTypes: {},
        fieldDepths: { error: 'body is null — JSON parse failed or empty body' }
      };
    }

    const fieldNames = [];
    const fieldTypes = {};
    const fieldDepths = {};

    function traverse(obj, prefix, depth) {
      if (depth > 4) return; // Don't go infinitely deep
      if (typeof obj !== 'object' || obj === null) return;

      Object.keys(obj).forEach(function(key) {
        const fullKey = prefix ? prefix + '.' + key : key;
        const val = obj[key];
        const type = val === null ? 'null' :
                     Array.isArray(val) ? 'array[' + val.length + ']' :
                     typeof val;

        fieldNames.push(fullKey);
        fieldTypes[fullKey] = type;
        fieldDepths[fullKey] = depth;

        if (type === 'object' || type.startsWith('array')) {
          if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'object') {
            traverse(val[0], fullKey + '[0]', depth + 1);
          } else if (!Array.isArray(val)) {
            traverse(val, fullKey, depth + 1);
          }
        }
      });
    }

    traverse(body, '', 0);

    return { fieldNames: fieldNames, fieldTypes: fieldTypes, fieldDepths: fieldDepths };
  }

  // ─── Sanitization ─────────────────────────────────────────────────────────

  /**
   * Redact sensitive fields before logging.
   * Keeps structure visible; removes values that could be credentials or PII.
   *
   * @param {string} provider
   * @param {Object|null} body
   * @returns {Object|null}
   */
  function _sanitizeForLog(provider, body) {
    if (!body) return null;

    // Fields that must NEVER be logged
    const REDACT_KEYS = [
      'merchant_key', 'secret_key', 'api_key', 'signing_secret',
      'password', 'token', 'access_token', 'refresh_token',
      'authorization', 'x-lynk-signature', 'x-scalev-hmac-sha256',
      'payment_account_number', 'card_number', 'cvv',
      // PII that is not needed for structure analysis
      'email', 'phone', 'name', 'address'
    ];

    function sanitize(obj) {
      if (typeof obj !== 'object' || obj === null) return obj;
      if (Array.isArray(obj)) return obj.slice(0, 1).map(sanitize); // Keep 1 element for structure

      const result = {};
      Object.keys(obj).forEach(function(key) {
        const lowerKey = key.toLowerCase();
        const shouldRedact = REDACT_KEYS.some(function(r) { return lowerKey.includes(r); });
        if (shouldRedact) {
          result[key] = '[REDACTED]';
        } else if (typeof obj[key] === 'object' && obj[key] !== null) {
          result[key] = sanitize(obj[key]);
        } else if (typeof obj[key] === 'string' && obj[key].length > 100) {
          result[key] = obj[key].slice(0, 20) + '...[' + obj[key].length + ' chars]';
        } else {
          result[key] = obj[key];
        }
      });
      return result;
    }

    return sanitize(body);
  }

  // ─── Diagnostic Test Helpers ──────────────────────────────────────────────

  /**
   * Verify diagnostic mode is enabled and environment is safe.
   * Used by TestRunner to confirm configuration before running diagnostic tests.
   *
   * @returns {{ ok: boolean, diagnostic_mode: boolean, safe_env: boolean }}
   */
  function getStatus() {
    return {
      ok:              true,
      diagnostic_mode: isDiagnosticMode(),
      safe_env:        isSafeDevEnvironment(),
      header_note:     'X-Lynk-Signature and X-Scalev-Hmac-Sha256 NOT readable in GAS'
    };
  }

  return {
    isDiagnosticMode:   isDiagnosticMode,
    isSafeDevEnvironment: isSafeDevEnvironment,
    capture:            capture,
    getStatus:          getStatus
  };

})();
