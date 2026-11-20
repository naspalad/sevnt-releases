/**
 * SupportService — Support-only operations for SEVNT License System.
 *
 * All functions in this module are exclusively for use by SEVNT Support staff.
 * Authentication (admin_secret) is enforced at the router level in Code.gs.
 *
 * Policy (from spec):
 * - Users CANNOT reset/deactivate their own devices
 * - Device slot resets require Support verification
 * - License recovery requires Support verification
 * - Every Support action is recorded in AUDIT_LOG with:
 *     - operator_email
 *     - ticket_id (required)
 *     - reason (required)
 *
 * resetDevice: Revoke a specific device, freeing its slot for a new device.
 * recoverLicense: Revoke all devices + optionally reissue license key.
 */

const SupportService = (function() {

  /**
   * Reset (revoke) a specific device on behalf of a support ticket.
   * After this, the freed slot can be activated by a new device.
   *
   * @param {Object} params
   * @param {string} params.device_id      - Device UUID to revoke
   * @param {string} params.reason         - Support reason description
   * @param {string} params.ticket_id      - Support ticket/case ID
   * @param {string} params.operator_email - Support staff email
   * @returns {{ ok: boolean, error?: string, message?: string }}
   */
  function resetDevice(params) {
    const { device_id, reason, ticket_id, operator_email } = params;
    const actor = 'support:' + operator_email;

    // Verify device exists before we start logging
    const device = DatabaseService.findDeviceById(device_id);
    if (!device) {
      AuditService.log(AuditService.EVENT_TYPE.SUPPORT_RESET,
        null, device_id, actor, 'FAILURE',
        { reason: 'DEVICE_NOT_FOUND', ticket_id: ticket_id });
      return { ok: false, error: 'DEVICE_NOT_FOUND', message: 'Device not found: ' + device_id };
    }

    if (device.status === DEVICE_STATUS.REVOKED) {
      AuditService.log(AuditService.EVENT_TYPE.SUPPORT_RESET,
        device.license_id, device_id, actor, 'FAILURE',
        { reason: 'ALREADY_REVOKED', ticket_id: ticket_id });
      return { ok: false, error: 'DEVICE_ALREADY_REVOKED', message: 'Device is already revoked' };
    }

    const result = DeviceService.revokeDevice(device_id, reason, actor, ticket_id);

    if (result.ok) {
      AuditService.log(AuditService.EVENT_TYPE.SUPPORT_RESET,
        device.license_id, device_id, actor, 'SUCCESS',
        { device_role: device.device_role, ticket_id: ticket_id, reason: reason });
    }

    return result;
  }

  /**
   * Recover a license: revoke all active devices (invalidate all tokens)
   * and optionally reissue a new license key.
   *
   * Use cases:
   * - Customer lost all access to their devices
   * - Device was stolen (revoke to prevent unauthorized use)
   * - Customer needs new license key (old one compromised)
   *
   * @param {Object} params
   * @param {string} params.license_id     - License UUID to recover
   * @param {string} params.reason         - Support reason
   * @param {string} params.ticket_id      - Support ticket ID
   * @param {string} params.operator_email - Support staff email
   * @param {boolean} params.reissue_key   - If true, generate and store new license key
   * @returns {{ ok: boolean, new_license_key?: string, message?: string }}
   */
  function recoverLicense(params) {
    const { license_id, reason, ticket_id, operator_email, reissue_key } = params;
    const actor = 'support:' + operator_email;

    const license = DatabaseService.findLicenseById(license_id);
    if (!license) {
      AuditService.log(AuditService.EVENT_TYPE.SUPPORT_RECOVER,
        license_id, null, actor, 'FAILURE',
        { reason: 'LICENSE_NOT_FOUND', ticket_id: ticket_id });
      return { ok: false, error: 'LICENSE_NOT_FOUND', message: 'License not found: ' + license_id };
    }

    // Revoke all active devices — invalidates all device tokens
    const revokedCount = DeviceService.revokeAllDevicesForLicense(
      license_id,
      reason + ' [recovery]',
      actor,
      ticket_id
    );

    let newLicenseKey = null;

    if (reissue_key) {
      // Generate new license key
      newLicenseKey = SecurityService.generateLicenseKey();
      const newKeyHash   = SecurityService.hashLicenseKey(newLicenseKey);
      const newKeyPrefix = SecurityService.licenseKeyPrefix(newLicenseKey);

      // Update license record with new key hash
      DatabaseService.updateLicense(license._rowIndex, {
        license_key_hash:   newKeyHash,
        license_key_prefix: newKeyPrefix,
        notes: (license.notes || '') + ' | KEY_REISSUED:' + new Date().toISOString() +
               ' by ' + actor + ' ticket:' + ticket_id
      });

      // Queue delivery email
      EmailService.queueLicenseDelivery(
        license_id,
        license.customer_email,
        newLicenseKey
      );
    }

    AuditService.log(AuditService.EVENT_TYPE.SUPPORT_RECOVER,
      license_id, null, actor, 'SUCCESS',
      {
        devices_revoked: revokedCount,
        key_reissued:    !!reissue_key,
        ticket_id:       ticket_id,
        reason:          reason
      });

    return {
      ok:              true,
      new_license_key: newLicenseKey, // null if not reissued
      message:         'License recovered. ' + revokedCount +
                       ' device(s) revoked.' +
                       (newLicenseKey ? ' New key delivered to ' + license.customer_email : '')
    };
  }

  return {
    resetDevice:     resetDevice,
    recoverLicense:  recoverLicense
  };

})();
