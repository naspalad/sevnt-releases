/**
 * DeviceService — Low-level device operations.
 *
 * Used by SupportService for revocation.
 * Device activation/validation is handled by LicenseService.
 *
 * All device mutations require Support authentication (enforced at the
 * router level in Code.gs, not repeated here).
 */

const DeviceService = (function() {

  /**
   * Revoke a device by device_id.
   * Called by SupportService.resetDevice().
   *
   * @param {string} deviceId
   * @param {string} reason        - Support reason string
   * @param {string} actor         - 'support:<email>'
   * @param {string} ticketId      - Support ticket ID
   * @returns {{ ok: boolean, error?: string, message?: string }}
   */
  function revokeDevice(deviceId, reason, actor, ticketId) {
    const device = DatabaseService.findDeviceById(deviceId);

    if (!device) {
      return { ok: false, error: 'DEVICE_NOT_FOUND', message: 'Device not found: ' + deviceId };
    }

    if (device.status === DEVICE_STATUS.REVOKED) {
      return { ok: false, error: 'DEVICE_ALREADY_REVOKED', message: 'Device is already revoked' };
    }

    const now = new Date().toISOString();

    DatabaseService.updateDevice(device._rowIndex, {
      status:            DEVICE_STATUS.REVOKED,
      revoked_at:        now,
      revocation_reason: reason + ' [ticket:' + ticketId + '] [by:' + actor + ']'
    });

    AuditService.log(AuditService.EVENT_TYPE.DEACTIVATE,
      device.license_id, deviceId, actor, 'SUCCESS',
      { reason: reason, ticket_id: ticketId });

    return { ok: true, message: 'Device revoked successfully' };
  }

  /**
   * Revoke all active devices for a license.
   * Used during license recovery to invalidate all existing tokens.
   *
   * @param {string} licenseId
   * @param {string} reason
   * @param {string} actor
   * @param {string} ticketId
   * @returns {number} Count of devices revoked
   */
  function revokeAllDevicesForLicense(licenseId, reason, actor, ticketId) {
    const devices = DatabaseService.findDevicesByLicenseId(licenseId);
    let revokedCount = 0;

    devices.forEach(function(device) {
      if (device.status === DEVICE_STATUS.ACTIVE) {
        const result = revokeDevice(device.device_id, reason, actor, ticketId);
        if (result.ok) revokedCount++;
      }
    });

    return revokedCount;
  }

  /**
   * Get all devices for a license (for Support panel display).
   *
   * @param {string} licenseId
   * @returns {Array<Object>} Device records (safe for support view, no token hashes)
   */
  function getDevicesSummary(licenseId) {
    const devices = DatabaseService.findDevicesByLicenseId(licenseId);
    return devices.map(function(d) {
      return {
        device_id:               d.device_id,
        device_role:             d.device_role,
        device_name:             d.device_name,
        status:                  d.status,
        activated_at:            d.activated_at,
        last_seen:               d.last_seen,
        paired_laptop_device_id: d.paired_laptop_device_id,
        revoked_at:              d.revoked_at,
        revocation_reason:       d.revocation_reason
        // machine_hash and device_token_hash are intentionally excluded
      };
    });
  }

  return {
    revokeDevice:              revokeDevice,
    revokeAllDevicesForLicense: revokeAllDevicesForLicense,
    getDevicesSummary:         getDevicesSummary
  };

})();
