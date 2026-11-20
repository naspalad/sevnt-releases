/**
 * DatabaseService — Google Spreadsheet persistence layer.
 *
 * Sheet structure (5 sheets, row 1 = header):
 *   LICENSES, DEVICES, PAYMENTS, EMAIL_OUTBOX, AUDIT_LOG
 *
 * Design decisions:
 * - All reads use in-memory full-sheet cache per request (1 getValues() call per sheet).
 * - Writes append rows or update specific cells.
 * - LockService is NOT used here — callers (LicenseService, DeviceService) must
 *   acquire the lock BEFORE calling write methods.
 * - Column indices are 0-based in this module's internal arrays; the spreadsheet
 *   uses 1-based rows/cols via setValues/getValues.
 *
 * QUOTA NOTE:
 * - Spreadsheet read: 1 read quota unit per cell.
 * - For large sheets, consider migrating to appendRow() + indexed cache.
 * - Current approach is sufficient for < 5,000 licenses and < 20,000 devices.
 */

const DatabaseService = (function() {

  // ─── Sheet Names ──────────────────────────────────────────────────────────

  const SHEET = {
    LICENSES:    'LICENSES',
    DEVICES:     'DEVICES',
    PAYMENTS:    'PAYMENTS',
    EMAIL_OUTBOX: 'EMAIL_OUTBOX',
    AUDIT_LOG:   'AUDIT_LOG'
  };

  // ─── Column Definitions (0-indexed, matches HEADER rows below) ───────────

  const COLS = {
    LICENSES: {
      license_id:         0,
      license_key_hash:   1,
      license_key_prefix: 2,
      customer_email:     3,
      order_id:           4,
      status:             5,
      payment_status:     6,
      created_at:         7,
      updated_at:         8,
      notes:              9
    },
    DEVICES: {
      device_id:              0,
      license_id:             1,
      device_role:            2,
      machine_hash:           3,
      device_token_hash:      4,
      device_name:            5,
      status:                 6,
      activated_at:           7,
      last_seen:              8,
      paired_laptop_device_id: 9,
      revoked_at:             10,
      revocation_reason:      11
    },
    PAYMENTS: {
      order_id:               0,
      provider:               1,
      provider_transaction_id: 2,
      customer_email:         3,
      amount:                 4,
      currency:               5,
      payment_status:         6,
      received_at:            7,
      processed_at:           8,
      license_id:             9,
      event_digest:           10
    },
    EMAIL_OUTBOX: {
      email_id:   0,
      license_id: 1,
      recipient:  2,
      template:   3,
      status:     4,
      attempts:   5,
      created_at: 6,
      sent_at:    7,
      last_error: 8,
      payload:    9
    },
    AUDIT_LOG: {
      event_id:   0,
      event_type: 1,
      license_id: 2,
      device_id:  3,
      actor:      4,
      result:     5,
      created_at: 6,
      details:    7
    }
  };

  const HEADERS = {
    LICENSES: ['license_id','license_key_hash','license_key_prefix','customer_email',
               'order_id','status','payment_status','created_at','updated_at','notes'],
    DEVICES:  ['device_id','license_id','device_role','machine_hash','device_token_hash',
               'device_name','status','activated_at','last_seen','paired_laptop_device_id',
               'revoked_at','revocation_reason'],
    PAYMENTS: ['order_id','provider','provider_transaction_id','customer_email','amount',
               'currency','payment_status','received_at','processed_at','license_id','event_digest'],
    EMAIL_OUTBOX: ['email_id','license_id','recipient','template','status','attempts',
                   'created_at','sent_at','last_error','payload'],
    AUDIT_LOG: ['event_id','event_type','license_id','device_id','actor','result',
                'created_at','details']
  };

  // ─── Spreadsheet Access ───────────────────────────────────────────────────

  function getSpreadsheet() {
    const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
    if (!id) throw new Error('SPREADSHEET_ID not configured in Script Properties');
    return SpreadsheetApp.openById(id);
  }

  function getSheet(name) {
    const ss = getSpreadsheet();
    const sheet = ss.getSheetByName(name);
    if (!sheet) throw new Error('Sheet not found: ' + name);
    return sheet;
  }

  /**
   * Initialize all sheets in the spreadsheet (create if missing, add headers).
   * Safe to call multiple times — only creates if not present.
   */
  function initSpreadsheet() {
    const ss = getSpreadsheet();
    Object.keys(SHEET).forEach(function(key) {
      const name = SHEET[key];
      let sheet = ss.getSheetByName(name);
      if (!sheet) {
        sheet = ss.insertSheet(name);
        Logger.log('Created sheet: ' + name);
      }
      // Ensure header row exists
      const firstCell = sheet.getRange(1, 1).getValue();
      if (!firstCell) {
        sheet.getRange(1, 1, 1, HEADERS[name].length)
             .setValues([HEADERS[name]]);
        Logger.log('Headers written for: ' + name);
      }
    });
  }

  // ─── Generic Helpers ──────────────────────────────────────────────────────

  /**
   * Read all data rows (excluding header) as array of objects.
   * Uses one getValues() call — efficient for the entire sheet.
   *
   * @param {string} sheetName - One of SHEET constants
   * @returns {Array<Object>} Array of row objects
   */
  function getAllRows(sheetName) {
    const sheet = getSheet(sheetName);
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return [];
    const cols = COLS[sheetName];
    const numCols = Object.keys(cols).length;
    const values = sheet.getRange(2, 1, lastRow - 1, numCols).getValues();
    return values.map(function(row, i) {
      const obj = { _rowIndex: i + 2 }; // 1-indexed, +1 for header
      Object.keys(cols).forEach(function(key) {
        obj[key] = row[cols[key]];
      });
      return obj;
    });
  }

  /**
   * Append a new row to the specified sheet.
   *
   * @param {string} sheetName
   * @param {Object} data - Object with keys matching column names
   */
  function appendRow(sheetName, data) {
    const sheet = getSheet(sheetName);
    const cols = COLS[sheetName];
    const numCols = Object.keys(cols).length;
    const row = new Array(numCols).fill('');
    Object.keys(cols).forEach(function(key) {
      row[cols[key]] = data[key] !== undefined ? data[key] : '';
    });
    sheet.appendRow(row);
  }

  /**
   * Update specific columns in a row identified by row index.
   *
   * @param {string} sheetName
   * @param {number} rowIndex - 1-indexed spreadsheet row number
   * @param {Object} updates - { column_name: new_value, ... }
   */
  function updateRow(sheetName, rowIndex, updates) {
    const sheet = getSheet(sheetName);
    const cols = COLS[sheetName];
    Object.keys(updates).forEach(function(key) {
      if (cols[key] !== undefined) {
        sheet.getRange(rowIndex, cols[key] + 1).setValue(updates[key]);
      }
    });
  }

  // ─── LICENSES ─────────────────────────────────────────────────────────────

  function findLicenseByKeyHash(keyHash) {
    const rows = getAllRows(SHEET.LICENSES);
    return rows.find(function(r) { return r.license_key_hash === keyHash; }) || null;
  }

  function findLicenseById(licenseId) {
    const rows = getAllRows(SHEET.LICENSES);
    return rows.find(function(r) { return r.license_id === licenseId; }) || null;
  }

  function findLicenseByEmail(email) {
    const rows = getAllRows(SHEET.LICENSES);
    return rows.filter(function(r) { return r.customer_email === email; });
  }

  function findLicenseByOrderId(orderId) {
    const rows = getAllRows(SHEET.LICENSES);
    return rows.find(function(r) { return r.order_id === orderId; }) || null;
  }

  function createLicense(data) {
    appendRow(SHEET.LICENSES, data);
  }

  function updateLicense(rowIndex, updates) {
    updates.updated_at = new Date().toISOString();
    updateRow(SHEET.LICENSES, rowIndex, updates);
  }

  // ─── DEVICES ──────────────────────────────────────────────────────────────

  function findDevicesByLicenseId(licenseId) {
    const rows = getAllRows(SHEET.DEVICES);
    return rows.filter(function(r) { return r.license_id === licenseId; });
  }

  function findDeviceByTokenHash(tokenHash) {
    const rows = getAllRows(SHEET.DEVICES);
    return rows.find(function(r) { return r.device_token_hash === tokenHash; }) || null;
  }

  function findDeviceById(deviceId) {
    const rows = getAllRows(SHEET.DEVICES);
    return rows.find(function(r) { return r.device_id === deviceId; }) || null;
  }

  function findActiveDeviceByRole(licenseId, role) {
    const rows = getAllRows(SHEET.DEVICES);
    return rows.find(function(r) {
      return r.license_id === licenseId &&
             r.device_role === role &&
             r.status === DEVICE_STATUS.ACTIVE;
    }) || null;
  }

  function createDevice(data) {
    appendRow(SHEET.DEVICES, data);
  }

  function updateDevice(rowIndex, updates) {
    updateRow(SHEET.DEVICES, rowIndex, updates);
  }

  function updateDeviceLastSeen(rowIndex) {
    updateRow(SHEET.DEVICES, rowIndex, { last_seen: new Date().toISOString() });
  }

  // ─── PAYMENTS ─────────────────────────────────────────────────────────────

  function findPaymentByOrderId(orderId) {
    const rows = getAllRows(SHEET.PAYMENTS);
    return rows.find(function(r) { return r.order_id === orderId; }) || null;
  }

  /**
   * Find payment by composite key (provider:order_id).
   * This is the Phase 4+ primary lookup — prevents cross-provider collisions.
   * The PAYMENTS sheet stores composite_key in the order_id column.
   *
   * @param {string} compositeKey - e.g. 'lynk:ORD-123' or 'scalev:ORD-123'
   * @returns {Object|null}
   */
  function findPaymentByCompositeKey(compositeKey) {
    const rows = getAllRows(SHEET.PAYMENTS);
    return rows.find(function(r) { return r.order_id === compositeKey; }) || null;
  }

  function findPaymentByEventDigest(digest) {
    const rows = getAllRows(SHEET.PAYMENTS);
    return rows.find(function(r) { return r.event_digest === digest; }) || null;
  }

  function createPayment(data) {
    appendRow(SHEET.PAYMENTS, data);
  }

  function updatePayment(rowIndex, updates) {
    updateRow(SHEET.PAYMENTS, rowIndex, updates);
  }

  // ─── EMAIL_OUTBOX ─────────────────────────────────────────────────────────

  function createEmailJob(data) {
    appendRow(SHEET.EMAIL_OUTBOX, data);
  }

  function findPendingEmails() {
    const rows = getAllRows(SHEET.EMAIL_OUTBOX);
    return rows.filter(function(r) {
      return r.status === EMAIL_STATUS.PENDING && (r.attempts || 0) < 3;
    });
  }

  function updateEmailJob(rowIndex, updates) {
    updateRow(SHEET.EMAIL_OUTBOX, rowIndex, updates);
  }

  // ─── AUDIT_LOG ────────────────────────────────────────────────────────────

  function createAuditEvent(data) {
    appendRow(SHEET.AUDIT_LOG, data);
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  return {
    SHEET:                    SHEET,
    COLS:                     COLS,
    initSpreadsheet:          initSpreadsheet,

    // Licenses
    findLicenseByKeyHash:     findLicenseByKeyHash,
    findLicenseById:          findLicenseById,
    findLicenseByEmail:       findLicenseByEmail,
    findLicenseByOrderId:     findLicenseByOrderId,
    createLicense:            createLicense,
    updateLicense:            updateLicense,

    // Devices
    findDevicesByLicenseId:   findDevicesByLicenseId,
    findDeviceByTokenHash:    findDeviceByTokenHash,
    findDeviceById:           findDeviceById,
    findActiveDeviceByRole:   findActiveDeviceByRole,
    createDevice:             createDevice,
    updateDevice:             updateDevice,
    updateDeviceLastSeen:     updateDeviceLastSeen,

    // Payments
    findPaymentByOrderId:        findPaymentByOrderId,
    findPaymentByCompositeKey:   findPaymentByCompositeKey,
    findPaymentByEventDigest:    findPaymentByEventDigest,
    createPayment:            createPayment,
    updatePayment:            updatePayment,

    // Email
    createEmailJob:           createEmailJob,
    findPendingEmails:        findPendingEmails,
    updateEmailJob:           updateEmailJob,

    // Audit
    createAuditEvent:         createAuditEvent
  };

})();
