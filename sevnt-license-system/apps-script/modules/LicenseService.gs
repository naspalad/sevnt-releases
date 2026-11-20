/**
 * LicenseService — License lifecycle management.
 *
 * Handles:
 *   - activate(params):  First activation of laptop or mobile companion
 *   - validate(params):  Validate an existing device token
 *
 * Concurrency:
 *   LockService.getScriptLock() is used for activation to prevent race conditions
 *   where two concurrent requests could occupy the same device slot.
 *
 * Invariants:
 *   - Each license_id may have AT MOST one active PRIMARY_LAPTOP
 *   - Each license_id may have AT MOST one active MOBILE_COMPANION
 *   - MOBILE_COMPANION cannot be activated before PRIMARY_LAPTOP
 *   - MOBILE_COMPANION must reference the paired laptop's device_id
 *   - Device tokens are single-issue: sent once at activation, never again
 *   - REVOKED licenses and REVOKED devices fail validation immediately
 */

const LicenseService = (function() {

  const LOCK_TIMEOUT_MS = 15000; // 15 seconds

  /**
   * Activate a device for a given license key.
   *
   * @param {Object} params
   * @param {string} params.license_key   - Raw license key (will be normalized + hashed)
   * @param {string} params.device_role   - PRIMARY_LAPTOP or MOBILE_COMPANION
   * @param {string} params.machine_id    - Machine fingerprint from client
   * @param {string} params.device_name   - Human-readable device name
   * @returns {{ ok: boolean, error?: string, message?: string,
   *             device_token?: string, device_id?: string,
   *             license_id?: string, issued_at?: string }}
   */
  function activate(params) {
    const { license_key, device_role, machine_id, device_name } = params;

    // Input validation
    if (!SecurityService.isValidLicenseKeyFormat(license_key)) {
      return fail('INVALID_LICENSE_KEY_FORMAT', 'License key format is invalid');
    }
    if (!SecurityService.isValidMachineId(machine_id)) {
      return fail('INVALID_MACHINE_ID', 'Machine ID is invalid or too short');
    }

    // Acquire lock to prevent concurrent slot occupation
    const lock = LockService.getScriptLock();
    try {
      lock.waitLock(LOCK_TIMEOUT_MS);
    } catch (e) {
      return fail('SERVER_BUSY', 'Server is busy — please retry in a moment');
    }

    try {
      return _activateWithLock(license_key, device_role, machine_id, device_name);
    } finally {
      lock.releaseLock();
    }
  }

  function _activateWithLock(license_key, device_role, machine_id, device_name) {
    const keyHash = SecurityService.hashLicenseKey(license_key);

    // 1. Find license
    const license = DatabaseService.findLicenseByKeyHash(keyHash);
    if (!license) {
      AuditService.log('ACTIVATE_' + device_role, null, null, 'user', 'FAILURE',
        { reason: 'LICENSE_NOT_FOUND', key_prefix: SecurityService.licenseKeyPrefix(license_key) });
      return fail('LICENSE_NOT_FOUND', 'License key not found');
    }

    // 2. Check license status
    if (license.status !== LICENSE_STATUS.ACTIVE) {
      AuditService.log('ACTIVATE_' + device_role, license.license_id, null, 'user', 'FAILURE',
        { reason: 'LICENSE_' + license.status });
      return fail('LICENSE_' + license.status, 'License is ' + license.status.toLowerCase());
    }

    // 3. Check payment status
    if (license.payment_status !== PAYMENT_STATUS.PAID) {
      AuditService.log('ACTIVATE_' + device_role, license.license_id, null, 'user', 'FAILURE',
        { reason: 'PAYMENT_NOT_COMPLETED', payment_status: license.payment_status });
      return fail('PAYMENT_NOT_COMPLETED', 'Payment has not been confirmed');
    }

    const machineHash = SecurityService.hashMachineId(machine_id);

    if (device_role === DEVICE_ROLES.PRIMARY_LAPTOP) {
      return _activateLaptop(license, machineHash, device_name);
    } else {
      return _activateMobile(license, machineHash, device_name);
    }
  }

  function _activateLaptop(license, machineHash, device_name) {
    // Check if laptop slot is already occupied
    const existing = DatabaseService.findActiveDeviceByRole(
      license.license_id, DEVICE_ROLES.PRIMARY_LAPTOP
    );

    if (existing) {
      // Check if this is the same machine (re-activation after reinstall)
      if (existing.machine_hash === machineHash) {
        // Re-activation of same machine — issue new token
        return _reactivateDevice(license, existing, device_name);
      }
      // Different machine — slot occupied, support required
      AuditService.log(AuditService.EVENT_TYPE.ACTIVATE_LAPTOP,
        license.license_id, null, 'user', 'FAILURE',
        { reason: 'SLOT_OCCUPIED', existing_device_id: existing.device_id });
      return fail(
        'DEVICE_SLOT_OCCUPIED_CONTACT_SEVNT_SUPPORT',
        'A laptop is already registered for this license. ' +
        'To transfer to a new device, please contact SEVNT Support.'
      );
    }

    return _issueNewDevice(license, DEVICE_ROLES.PRIMARY_LAPTOP, machineHash, device_name, null);
  }

  function _activateMobile(license, machineHash, device_name) {
    // Mobile requires an active laptop first
    const laptop = DatabaseService.findActiveDeviceByRole(
      license.license_id, DEVICE_ROLES.PRIMARY_LAPTOP
    );

    if (!laptop) {
      AuditService.log(AuditService.EVENT_TYPE.ACTIVATE_MOBILE,
        license.license_id, null, 'user', 'FAILURE',
        { reason: 'LAPTOP_NOT_ACTIVATED' });
      return fail('LAPTOP_NOT_ACTIVATED',
        'You must activate SEVNT Studio on your laptop before activating the mobile companion');
    }

    // Check if mobile slot is already occupied
    const existing = DatabaseService.findActiveDeviceByRole(
      license.license_id, DEVICE_ROLES.MOBILE_COMPANION
    );

    if (existing) {
      if (existing.machine_hash === machineHash) {
        return _reactivateDevice(license, existing, device_name);
      }
      AuditService.log(AuditService.EVENT_TYPE.ACTIVATE_MOBILE,
        license.license_id, null, 'user', 'FAILURE',
        { reason: 'MOBILE_SLOT_OCCUPIED', existing_device_id: existing.device_id });
      return fail(
        'DEVICE_SLOT_OCCUPIED_CONTACT_SEVNT_SUPPORT',
        'A mobile companion is already registered for this license. ' +
        'To transfer to a new device, please contact SEVNT Support.'
      );
    }

    return _issueNewDevice(license, DEVICE_ROLES.MOBILE_COMPANION, machineHash, device_name, laptop.device_id);
  }

  function _issueNewDevice(license, role, machineHash, deviceName, pairedLaptopId) {
    const now = new Date().toISOString();
    const deviceId    = SecurityService.generateId();
    const rawToken    = SecurityService.generateDeviceToken();
    const tokenHash   = SecurityService.hashDeviceToken(rawToken);

    DatabaseService.createDevice({
      device_id:               deviceId,
      license_id:              license.license_id,
      device_role:             role,
      machine_hash:            machineHash,
      device_token_hash:       tokenHash,
      device_name:             deviceName,
      status:                  DEVICE_STATUS.ACTIVE,
      activated_at:            now,
      last_seen:               now,
      paired_laptop_device_id: pairedLaptopId || '',
      revoked_at:              '',
      revocation_reason:       ''
    });

    const eventType = role === DEVICE_ROLES.PRIMARY_LAPTOP
      ? AuditService.EVENT_TYPE.ACTIVATE_LAPTOP
      : AuditService.EVENT_TYPE.ACTIVATE_MOBILE;

    AuditService.log(eventType, license.license_id, deviceId, 'user', 'SUCCESS',
      { device_name: deviceName, device_role: role });

    return {
      ok:          true,
      device_token: rawToken,  // Raw token: sent ONCE to client
      device_id:   deviceId,
      license_id:  license.license_id,
      issued_at:   now
    };
  }

  function _reactivateDevice(license, existing, newDeviceName) {
    // Revoke old token and issue a new one for the same machine
    const now      = new Date().toISOString();
    const rawToken = SecurityService.generateDeviceToken();
    const tokenHash = SecurityService.hashDeviceToken(rawToken);

    DatabaseService.updateDevice(existing._rowIndex, {
      device_token_hash: tokenHash,
      device_name:       newDeviceName || existing.device_name,
      last_seen:         now,
      activated_at:      now
    });

    AuditService.log(AuditService.EVENT_TYPE.ACTIVATE_LAPTOP,
      license.license_id, existing.device_id, 'user', 'SUCCESS',
      { reason: 'REACTIVATION', device_name: newDeviceName || existing.device_name });

    return {
      ok:          true,
      device_token: rawToken,
      device_id:   existing.device_id,
      license_id:  license.license_id,
      issued_at:   now
    };
  }

  // ─── Validate ─────────────────────────────────────────────────────────────

  /**
   * Validate a device token against a machine ID.
   *
   * @param {Object} params
   * @param {string} params.device_token - Raw token from client cache
   * @param {string} params.machine_id   - Machine fingerprint from client
   * @returns {{ ok: boolean, error?: string, ... }}
   */
  function validate(params) {
    const { device_token, machine_id } = params;

    if (!device_token || device_token.length < 32) {
      return fail('INVALID_TOKEN', 'Device token is invalid');
    }
    if (!SecurityService.isValidMachineId(machine_id)) {
      return fail('INVALID_MACHINE_ID', 'Machine ID is invalid');
    }

    const tokenHash   = SecurityService.hashDeviceToken(device_token);
    const machineHash = SecurityService.hashMachineId(machine_id);

    const device = DatabaseService.findDeviceByTokenHash(tokenHash);
    if (!device) {
      AuditService.log(AuditService.EVENT_TYPE.VALIDATE, null, null, 'user', 'FAILURE',
        { reason: 'TOKEN_NOT_FOUND' });
      return fail('TOKEN_INVALID', 'Device token not found');
    }

    // Machine fingerprint must match
    if (device.machine_hash !== machineHash) {
      AuditService.log(AuditService.EVENT_TYPE.VALIDATE,
        device.license_id, device.device_id, 'user', 'FAILURE',
        { reason: 'MACHINE_MISMATCH' });
      return fail('MACHINE_MISMATCH', 'Device token does not match this machine');
    }

    // Device must be active
    if (device.status !== DEVICE_STATUS.ACTIVE) {
      AuditService.log(AuditService.EVENT_TYPE.VALIDATE,
        device.license_id, device.device_id, 'user', 'FAILURE',
        { reason: 'DEVICE_' + device.status });
      return fail('DEVICE_REVOKED', 'This device has been revoked');
    }

    // License must be active
    const license = DatabaseService.findLicenseById(device.license_id);
    if (!license || license.status !== LICENSE_STATUS.ACTIVE) {
      AuditService.log(AuditService.EVENT_TYPE.VALIDATE,
        device.license_id, device.device_id, 'user', 'FAILURE',
        { reason: 'LICENSE_NOT_ACTIVE' });
      return fail('LICENSE_REVOKED', 'License is not active');
    }

    // Update last_seen
    DatabaseService.updateDeviceLastSeen(device._rowIndex);

    AuditService.log(AuditService.EVENT_TYPE.VALIDATE,
      device.license_id, device.device_id, 'user', 'SUCCESS', {});

    return {
      ok:          true,
      license_id:  device.license_id,
      device_id:   device.device_id,
      device_role: device.device_role
    };
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  function fail(error, message) {
    return { ok: false, error: error, message: message };
  }

  return {
    activate: activate,
    validate: validate
  };

})();
