/**
 * AuditService — Immutable audit logging for the SEVNT License System.
 *
 * Every significant action (activate, validate, support operations, errors)
 * is written to the AUDIT_LOG sheet. Rows are append-only.
 *
 * Log format:
 *   event_id:   UUID
 *   event_type: Enum string (see EVENT_TYPE below)
 *   license_id: Related license UUID (or empty)
 *   device_id:  Related device UUID (or empty)
 *   actor:      'system' | 'support:<email>' | 'user'
 *   result:     'SUCCESS' | 'FAILURE'
 *   created_at: ISO8601
 *   details:    JSON string (sanitized — no secrets/tokens)
 */

const AuditService = (function() {

  const EVENT_TYPE = {
    ACTIVATE_LAPTOP:    'ACTIVATE_LAPTOP',
    ACTIVATE_MOBILE:    'ACTIVATE_MOBILE',
    VALIDATE:           'VALIDATE',
    DEACTIVATE:         'DEACTIVATE',
    SUPPORT_RESET:      'SUPPORT_RESET',
    SUPPORT_RECOVER:    'SUPPORT_RECOVER',
    LICENSE_CREATED:    'LICENSE_CREATED',
    LICENSE_REVOKED:    'LICENSE_REVOKED',
    PAYMENT_RECEIVED:   'PAYMENT_RECEIVED',
    EMAIL_QUEUED:       'EMAIL_QUEUED',
    EMAIL_SENT:         'EMAIL_SENT',
    EMAIL_FAILED:       'EMAIL_FAILED',
    UNAUTHORIZED_ADMIN: 'UNAUTHORIZED_ADMIN',
    ERROR:              'ERROR'
  };

  /**
   * Write an audit log entry.
   *
   * @param {string} eventType  - One of EVENT_TYPE values
   * @param {string} licenseId  - License UUID (or null)
   * @param {string} deviceId   - Device UUID (or null)
   * @param {string} actor      - 'system', 'support:email@...', 'user'
   * @param {string} result     - 'SUCCESS' or 'FAILURE'
   * @param {Object} details    - Arbitrary details (must NOT contain secrets)
   */
  function log(eventType, licenseId, deviceId, actor, result, details) {
    try {
      DatabaseService.createAuditEvent({
        event_id:   SecurityService.generateId(),
        event_type: eventType,
        license_id: licenseId  || '',
        device_id:  deviceId   || '',
        actor:      actor      || 'system',
        result:     result     || 'SUCCESS',
        created_at: new Date().toISOString(),
        details:    details ? JSON.stringify(sanitizeDetails(details)) : ''
      });
    } catch (err) {
      // Audit log failure must not break the main operation
      Logger.log('AUDIT_LOG_FAILURE: ' + err.message + ' | event_type=' + eventType);
    }
  }

  /**
   * Remove sensitive fields from audit details before logging.
   * Prevents secrets/tokens appearing in the spreadsheet.
   *
   * @param {Object} details
   * @returns {Object} Sanitized copy
   */
  function sanitizeDetails(details) {
    const BLOCKED_KEYS = [
      'admin_secret', 'device_token', 'license_key', 'hmac_key',
      'token', 'secret', 'password', 'key_hash'
    ];
    const result = {};
    Object.keys(details).forEach(function(k) {
      if (BLOCKED_KEYS.indexOf(k.toLowerCase()) === -1) {
        result[k] = details[k];
      } else {
        result[k] = '[REDACTED]';
      }
    });
    return result;
  }

  return {
    EVENT_TYPE: EVENT_TYPE,
    log:        log
  };

})();
