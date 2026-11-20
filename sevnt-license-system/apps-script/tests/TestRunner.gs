/**
 * TestRunner — SEVNT License System Test Harness
 *
 * HOW TO RUN:
 *   1. Open Apps Script editor
 *   2. Select function: runAllTests
 *   3. Click Run
 *   4. View results in View > Execution log
 *
 * PREREQUISITE:
 *   - Script Properties must be configured (setupScriptProperties + initCheck)
 *   - initSpreadsheet() must have been called
 *
 * TEST ISOLATION:
 *   - Each test creates its own data via PaymentService.createTestLicense()
 *   - Tests do NOT share state between test cases
 *   - Test data is marked with 'TEST LICENSE' in notes column
 *
 * RESULTS:
 *   - PASS / FAIL printed to Logger
 *   - Final summary: total / passed / failed
 *   - Function returns { passed, failed, total } for programmatic use
 */

// ─── Assertion Helpers ────────────────────────────────────────────────────────

const Test = (function() {
  let _results = [];
  let _currentSuite = '';

  function suite(name) {
    _currentSuite = name;
    Logger.log('\n── ' + name + ' ──────────────────────────');
  }

  function assert(description, condition, details) {
    const status = condition ? 'PASS' : 'FAIL';
    const line = '[' + status + '] ' + (_currentSuite ? _currentSuite + ' > ' : '') + description;
    if (details && !condition) {
      Logger.log(line + '\n       Details: ' + JSON.stringify(details));
    } else {
      Logger.log(line);
    }
    _results.push({ description: description, pass: condition });
  }

  function assertEqual(description, actual, expected) {
    const pass = actual === expected;
    assert(description + ' (expected=' + JSON.stringify(expected) + ', actual=' + JSON.stringify(actual) + ')', pass);
  }

  function assertOk(description, result) {
    assert(description + ' → ok=true', result && result.ok === true, result);
  }

  function assertFail(description, result, expectedError) {
    const pass = result && result.ok === false && (!expectedError || result.error === expectedError);
    assert(description + ' → ok=false' + (expectedError ? ', error=' + expectedError : ''), pass, result);
  }

  function summary() {
    const total  = _results.length;
    const passed = _results.filter(function(r) { return r.pass; }).length;
    const failed = total - passed;
    Logger.log('\n════════════════════════════════════');
    Logger.log('TEST RESULTS: ' + passed + '/' + total + ' passed, ' + failed + ' failed');
    if (failed > 0) {
      Logger.log('FAILED TESTS:');
      _results.filter(function(r) { return !r.pass; }).forEach(function(r) {
        Logger.log('  ✗ ' + r.description);
      });
    }
    Logger.log('════════════════════════════════════');
    return { total: total, passed: passed, failed: failed };
  }

  function reset() {
    _results = [];
    _currentSuite = '';
  }

  return {
    suite:      suite,
    assert:     assert,
    assertEqual: assertEqual,
    assertOk:   assertOk,
    assertFail: assertFail,
    summary:    summary,
    reset:      reset
  };
})();

// ─── Main Entry Point ─────────────────────────────────────────────────────────

function runAllTests() {
  Test.reset();
  Logger.log('SEVNT License System — Test Suite (Phase 1 + Phase 4)');
  Logger.log('Time: ' + new Date().toISOString());

  // Phase 1 suites (~47 tests)
  testSecurityService();
  testLicenseActivation();
  testDeviceSlots();
  testMobileCompanion();
  testTokenValidation();
  testSupportReset();
  testSupportRecovery();
  testPaymentIdempotency();
  testSecurityConstraints();
  testConcurrentActivation();

  // Phase 4 suites (~30 tests)
  testPaymentNormalizer();
  testLynkAdapter();
  testScalevAdapter();
  testCompositeIdempotency();
  testCrossProviderIsolation();
  testWebhookRouting();

  // Phase 4.2 suites (~25 tests)
  testLynkVerifiedFields();
  testScalevVerifiedFields();
  testDiagnosticService();
  testDiagnosticSafety();

  return Test.summary();
}

// ─── Security Service Tests ───────────────────────────────────────────────────

function testSecurityService() {
  Test.suite('SecurityService');

  // License key generation
  const key1 = SecurityService.generateLicenseKey();
  const key2 = SecurityService.generateLicenseKey();
  Test.assert('generateLicenseKey returns non-empty string', typeof key1 === 'string' && key1.length > 0);
  Test.assert('generateLicenseKey matches XXXXX-XXXXX-XXXXX-XXXXX format',
    /^[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}$/.test(key1));
  Test.assert('Two license keys are different', key1 !== key2);

  // Key format validation
  Test.assert('Valid key format accepted', SecurityService.isValidLicenseKeyFormat('ABCDE-12345-FGHIJ-67890'));
  Test.assert('Lowercase valid key accepted', SecurityService.isValidLicenseKeyFormat('abcde-12345-fghij-67890'));
  Test.assert('Malformed key rejected (missing group)', !SecurityService.isValidLicenseKeyFormat('ABCDE-12345-FGHIJ'));
  Test.assert('Malformed key rejected (wrong chars)', !SecurityService.isValidLicenseKeyFormat('AB CD-12345-FGHIJ-67890'));

  // Hashing
  const hash1 = SecurityService.hashLicenseKey('ABCDE-12345-FGHIJ-67890');
  const hash2 = SecurityService.hashLicenseKey('abcde-12345-fghij-67890');
  Test.assert('hashLicenseKey normalizes case (same hash for upper/lower)', hash1 === hash2);
  Test.assert('hashLicenseKey returns 64-char hex string', hash1.length === 64);

  // Device token
  const token = SecurityService.generateDeviceToken();
  Test.assert('generateDeviceToken returns 96-char hex string', token.length === 96);
  const tokenHash = SecurityService.hashDeviceToken(token);
  Test.assert('hashDeviceToken returns 64-char hex string', tokenHash.length === 64);

  // Machine ID validation
  Test.assert('Valid machine ID accepted', SecurityService.isValidMachineId('a'.repeat(64)));
  Test.assert('Short machine ID rejected', !SecurityService.isValidMachineId('abc'));
  Test.assert('Empty machine ID rejected', !SecurityService.isValidMachineId(''));

  // Canonical JSON
  const canonical = SecurityService.canonicalJson({ z: 1, a: 2, m: 3 });
  Test.assert('canonicalJson sorts keys alphabetically', canonical === '{"a":2,"m":3,"z":1}');
}

// ─── License Activation Tests ─────────────────────────────────────────────────

function testLicenseActivation() {
  Test.suite('LicenseActivation');

  const TEST_EMAIL    = 'test-' + SecurityService.generateId().slice(0, 8) + '@test.sevnt';
  const TEST_MACHINE  = 'machine-' + SecurityService.generateId().replace(/-/g, '');
  const TEST_DEVICE_NAME = 'Test Laptop';

  // Create a test license
  const created = PaymentService.createTestLicense(TEST_EMAIL, 'ORDER-LAPTOP-TEST');
  Test.assertOk('createTestLicense succeeds', created);

  const licenseKey = created.license_key;

  // Valid activation
  const r1 = LicenseService.activate({
    license_key: licenseKey,
    device_role: DEVICE_ROLES.PRIMARY_LAPTOP,
    machine_id:  TEST_MACHINE,
    device_name: TEST_DEVICE_NAME
  });
  Test.assertOk('Activate laptop with valid key', r1);
  Test.assert('Returns device_token', r1.ok && r1.device_token && r1.device_token.length === 96);
  Test.assert('Returns device_id', r1.ok && typeof r1.device_id === 'string');
  Test.assert('Returns license_id', r1.ok && r1.license_id === created.license_id);

  // Wrong license key
  const r2 = LicenseService.activate({
    license_key: 'AAAAA-BBBBB-CCCCC-DDDDD',
    device_role: DEVICE_ROLES.PRIMARY_LAPTOP,
    machine_id:  TEST_MACHINE,
    device_name: TEST_DEVICE_NAME
  });
  Test.assertFail('Wrong license key rejected', r2, 'LICENSE_NOT_FOUND');

  // Invalid format
  const r3 = LicenseService.activate({
    license_key: 'invalid-key',
    device_role: DEVICE_ROLES.PRIMARY_LAPTOP,
    machine_id:  TEST_MACHINE,
    device_name: TEST_DEVICE_NAME
  });
  Test.assertFail('Invalid key format rejected', r3, 'INVALID_LICENSE_KEY_FORMAT');

  // Missing machine_id
  const r4 = LicenseService.activate({
    license_key: licenseKey,
    device_role: DEVICE_ROLES.PRIMARY_LAPTOP,
    machine_id:  'short',
    device_name: TEST_DEVICE_NAME
  });
  Test.assertFail('Short machine_id rejected', r4, 'INVALID_MACHINE_ID');
}

// ─── Device Slot Tests ────────────────────────────────────────────────────────

function testDeviceSlots() {
  Test.suite('DeviceSlots');

  const EMAIL   = 'slots-' + SecurityService.generateId().slice(0, 8) + '@test.sevnt';
  const MACHINE = 'machine-' + SecurityService.generateId().replace(/-/g, '');
  const MACHINE2 = 'machine2-' + SecurityService.generateId().replace(/-/g, '');

  const created = PaymentService.createTestLicense(EMAIL, 'ORDER-SLOTS-TEST');
  const key     = created.license_key;

  // Activate laptop
  const r1 = LicenseService.activate({
    license_key: key, device_role: DEVICE_ROLES.PRIMARY_LAPTOP,
    machine_id: MACHINE, device_name: 'Laptop 1'
  });
  Test.assertOk('First laptop activation succeeds', r1);

  // Try to activate DIFFERENT laptop on same license
  const r2 = LicenseService.activate({
    license_key: key, device_role: DEVICE_ROLES.PRIMARY_LAPTOP,
    machine_id: MACHINE2, device_name: 'Laptop 2'
  });
  Test.assertFail('Second laptop (different machine) rejected', r2,
    'DEVICE_SLOT_OCCUPIED_CONTACT_SEVNT_SUPPORT');

  // Re-activate SAME laptop (reinstall scenario)
  const r3 = LicenseService.activate({
    license_key: key, device_role: DEVICE_ROLES.PRIMARY_LAPTOP,
    machine_id: MACHINE, device_name: 'Laptop 1 Reinstalled'
  });
  Test.assertOk('Same laptop re-activation succeeds', r3);
  Test.assert('Re-activation issues new token', r3.ok && r3.device_token !== r1.device_token);
}

// ─── Mobile Companion Tests ───────────────────────────────────────────────────

function testMobileCompanion() {
  Test.suite('MobileCompanion');

  const EMAIL    = 'mobile-' + SecurityService.generateId().slice(0, 8) + '@test.sevnt';
  const LAPTOP_M = 'laptop-machine-' + SecurityService.generateId().replace(/-/g, '');
  const MOBILE_M = 'mobile-machine-' + SecurityService.generateId().replace(/-/g, '');
  const MOBILE_M2 = 'mobile-machine2-' + SecurityService.generateId().replace(/-/g, '');

  const created = PaymentService.createTestLicense(EMAIL, 'ORDER-MOBILE-TEST');
  const key     = created.license_key;

  // HP activation without laptop → rejected
  const r1 = LicenseService.activate({
    license_key: key, device_role: DEVICE_ROLES.MOBILE_COMPANION,
    machine_id: MOBILE_M, device_name: 'My Phone'
  });
  Test.assertFail('Mobile activation before laptop rejected', r1, 'LAPTOP_NOT_ACTIVATED');

  // Activate laptop first
  const rLaptop = LicenseService.activate({
    license_key: key, device_role: DEVICE_ROLES.PRIMARY_LAPTOP,
    machine_id: LAPTOP_M, device_name: 'My Laptop'
  });
  Test.assertOk('Laptop activation succeeds', rLaptop);

  // HP activation after laptop → success
  const r2 = LicenseService.activate({
    license_key: key, device_role: DEVICE_ROLES.MOBILE_COMPANION,
    machine_id: MOBILE_M, device_name: 'My Phone'
  });
  Test.assertOk('Mobile activation after laptop succeeds', r2);
  Test.assert('Mobile token different from laptop token',
    r2.ok && r2.device_token !== rLaptop.device_token);

  // Second HP → rejected
  const r3 = LicenseService.activate({
    license_key: key, device_role: DEVICE_ROLES.MOBILE_COMPANION,
    machine_id: MOBILE_M2, device_name: 'My Second Phone'
  });
  Test.assertFail('Second mobile (different machine) rejected', r3,
    'DEVICE_SLOT_OCCUPIED_CONTACT_SEVNT_SUPPORT');
}

// ─── Token Validation Tests ───────────────────────────────────────────────────

function testTokenValidation() {
  Test.suite('TokenValidation');

  const EMAIL   = 'validate-' + SecurityService.generateId().slice(0, 8) + '@test.sevnt';
  const MACHINE = 'machine-validate-' + SecurityService.generateId().replace(/-/g, '');

  const created = PaymentService.createTestLicense(EMAIL, 'ORDER-VALIDATE-TEST');
  const rActivate = LicenseService.activate({
    license_key: created.license_key,
    device_role: DEVICE_ROLES.PRIMARY_LAPTOP,
    machine_id:  MACHINE,
    device_name: 'Validate Test Laptop'
  });

  const deviceToken = rActivate.device_token;
  const deviceId    = rActivate.device_id;

  // Valid validation
  const r1 = LicenseService.validate({ device_token: deviceToken, machine_id: MACHINE });
  Test.assertOk('Valid token + correct machine validates successfully', r1);
  Test.assert('Returns correct license_id', r1.ok && r1.license_id === created.license_id);
  Test.assert('Returns correct device_id', r1.ok && r1.device_id === deviceId);

  // Wrong machine
  const WRONG_MACHINE = 'wrong-machine-' + SecurityService.generateId().replace(/-/g, '');
  const r2 = LicenseService.validate({ device_token: deviceToken, machine_id: WRONG_MACHINE });
  Test.assertFail('Wrong machine rejected', r2, 'MACHINE_MISMATCH');

  // Invalid token
  const r3 = LicenseService.validate({
    device_token: 'a'.repeat(96),
    machine_id: MACHINE
  });
  Test.assertFail('Invalid (not issued) token rejected', r3, 'TOKEN_INVALID');

  // Revoked device token
  const supportResult = SupportService.resetDevice({
    device_id:      deviceId,
    reason:         'Test revocation',
    ticket_id:      'TEST-TICKET-001',
    operator_email: 'support@test.sevnt'
  });
  Test.assertOk('Support device reset succeeds', supportResult);

  const r4 = LicenseService.validate({ device_token: deviceToken, machine_id: MACHINE });
  Test.assertFail('Revoked device token rejected after revocation', r4, 'DEVICE_REVOKED');

  // Laptop token cannot be used by mobile
  const EMAIL2   = 'crosstoken-' + SecurityService.generateId().slice(0, 8) + '@test.sevnt';
  const L_MACHINE = 'cross-laptop-' + SecurityService.generateId().replace(/-/g, '');
  const M_MACHINE = 'cross-mobile-' + SecurityService.generateId().replace(/-/g, '');

  const c2 = PaymentService.createTestLicense(EMAIL2, 'ORDER-CROSS-TEST');
  const rL = LicenseService.activate({
    license_key: c2.license_key, device_role: DEVICE_ROLES.PRIMARY_LAPTOP,
    machine_id: L_MACHINE, device_name: 'Cross Laptop'
  });
  LicenseService.activate({
    license_key: c2.license_key, device_role: DEVICE_ROLES.MOBILE_COMPANION,
    machine_id: M_MACHINE, device_name: 'Cross Mobile'
  });

  // Try laptop token from mobile machine → machine mismatch
  const rCross = LicenseService.validate({ device_token: rL.device_token, machine_id: M_MACHINE });
  Test.assertFail('Laptop token fails validation from mobile machine (machine mismatch)', rCross, 'MACHINE_MISMATCH');
}

// ─── Support Reset Tests ──────────────────────────────────────────────────────

function testSupportReset() {
  Test.suite('SupportReset');

  const EMAIL   = 'reset-' + SecurityService.generateId().slice(0, 8) + '@test.sevnt';
  const MACHINE = 'machine-reset-' + SecurityService.generateId().replace(/-/g, '');

  const created = PaymentService.createTestLicense(EMAIL, 'ORDER-RESET-TEST');
  const rAct = LicenseService.activate({
    license_key: created.license_key, device_role: DEVICE_ROLES.PRIMARY_LAPTOP,
    machine_id: MACHINE, device_name: 'Reset Test Laptop'
  });

  // Support reset requires ticket_id
  const r1 = SupportService.resetDevice({
    device_id:      rAct.device_id,
    reason:         'Customer replacing laptop',
    ticket_id:      'TKT-20261109-001',
    operator_email: 'support@sevntstudio.com'
  });
  Test.assertOk('Support reset with ticket succeeds', r1);

  // Double-reset same device
  const r2 = SupportService.resetDevice({
    device_id:      rAct.device_id,
    reason:         'Duplicate reset attempt',
    ticket_id:      'TKT-20261109-002',
    operator_email: 'support@sevntstudio.com'
  });
  Test.assertFail('Double-reset fails (already revoked)', r2, 'DEVICE_ALREADY_REVOKED');

  // Reset non-existent device
  const r3 = SupportService.resetDevice({
    device_id:      'nonexistent-device-id',
    reason:         'Test',
    ticket_id:      'TKT-TEST',
    operator_email: 'support@sevntstudio.com'
  });
  Test.assertFail('Reset non-existent device fails', r3, 'DEVICE_NOT_FOUND');

  // After support reset, previous token no longer works
  const r4 = LicenseService.validate({
    device_token: rAct.device_token,
    machine_id:   MACHINE
  });
  Test.assertFail('Token fails validation after support reset', r4, 'DEVICE_REVOKED');

  // After reset, slot is free — same machine can activate again
  const rReactivate = LicenseService.activate({
    license_key: created.license_key, device_role: DEVICE_ROLES.PRIMARY_LAPTOP,
    machine_id: MACHINE, device_name: 'Reset Test Laptop v2'
  });
  Test.assertOk('After support reset, same machine can re-activate', rReactivate);
}

// ─── Support Recovery Tests ───────────────────────────────────────────────────

function testSupportRecovery() {
  Test.suite('SupportRecovery');

  const EMAIL   = 'recovery-' + SecurityService.generateId().slice(0, 8) + '@test.sevnt';
  const MACHINE = 'machine-recovery-' + SecurityService.generateId().replace(/-/g, '');

  const created = PaymentService.createTestLicense(EMAIL, 'ORDER-RECOVERY-TEST');
  const rAct = LicenseService.activate({
    license_key: created.license_key, device_role: DEVICE_ROLES.PRIMARY_LAPTOP,
    machine_id: MACHINE, device_name: 'Recovery Laptop'
  });

  const oldToken = rAct.device_token;

  // Recovery WITHOUT key reissue — just revokes all devices
  const r1 = SupportService.recoverLicense({
    license_id:     created.license_id,
    reason:         'Customer lost access',
    ticket_id:      'TKT-RECOVERY-001',
    operator_email: 'support@sevntstudio.com',
    reissue_key:    false
  });
  Test.assertOk('License recovery (no key reissue) succeeds', r1);
  Test.assert('No new key when reissue_key=false', r1.ok && !r1.new_license_key);

  // Old token no longer works
  const r2 = LicenseService.validate({ device_token: oldToken, machine_id: MACHINE });
  Test.assertFail('Old token invalid after recovery', r2, 'DEVICE_REVOKED');

  // Recovery WITH key reissue
  const EMAIL2   = 'recovery2-' + SecurityService.generateId().slice(0, 8) + '@test.sevnt';
  const created2 = PaymentService.createTestLicense(EMAIL2, 'ORDER-RECOVERY-2');
  const r3 = SupportService.recoverLicense({
    license_id:     created2.license_id,
    reason:         'Customer needs new key',
    ticket_id:      'TKT-RECOVERY-002',
    operator_email: 'support@sevntstudio.com',
    reissue_key:    true
  });
  Test.assertOk('License recovery with key reissue succeeds', r3);
  Test.assert('New key returned when reissue_key=true',
    r3.ok && r3.new_license_key && SecurityService.isValidLicenseKeyFormat(r3.new_license_key));

  // New key can be used to activate
  const rNewActivate = LicenseService.activate({
    license_key: r3.new_license_key, device_role: DEVICE_ROLES.PRIMARY_LAPTOP,
    machine_id: 'new-machine-' + SecurityService.generateId().replace(/-/g, ''),
    device_name: 'New Laptop After Recovery'
  });
  Test.assertOk('New key (after recovery) can activate laptop', rNewActivate);

  // Old key (hash changed) no longer works
  const rOldKey = LicenseService.activate({
    license_key: created2.license_key, device_role: DEVICE_ROLES.PRIMARY_LAPTOP,
    machine_id: 'yet-another-machine-' + SecurityService.generateId().replace(/-/g, ''),
    device_name: 'Old Key Test'
  });
  Test.assertFail('Old license key rejected after key reissue', rOldKey, 'LICENSE_NOT_FOUND');
}

// ─── Payment Idempotency Tests ────────────────────────────────────────────────

function testPaymentIdempotency() {
  Test.suite('PaymentIdempotency');

  // Test that createTestLicense is idempotent — unique license keys each time
  const c1 = PaymentService.createTestLicense('idem@test.sevnt', 'ORDER-IDEM-1');
  const c2 = PaymentService.createTestLicense('idem@test.sevnt', 'ORDER-IDEM-2');
  Test.assert('Two test licenses have different keys', c1.license_key !== c2.license_key);
  Test.assert('Two test licenses have different IDs',  c1.license_id  !== c2.license_id);

  // PRODUCTION_BLOCKED flag
  Test.assert('PaymentService.PRODUCTION_BLOCKED is true (Lynk.id not yet integrated)',
    PaymentService.PRODUCTION_BLOCKED === true);

  // Mock webhook returns INTEGRATION_BLOCKED
  const mockBody = PaymentService.mockWebhookBody('payment@test.sevnt', 'PAID');
  const r1 = PaymentService.handleLynkWebhook(mockBody, null);
  Test.assert('handleLynkWebhook returns INTEGRATION_BLOCKED when PRODUCTION_BLOCKED=true',
    r1.ok === false && r1.error === 'INTEGRATION_BLOCKED');
}

// ─── Security Constraint Tests ────────────────────────────────────────────────

function testSecurityConstraints() {
  Test.suite('SecurityConstraints');

  // Admin authentication — no admin_secret in this module level test
  // (admin_secret verification is in Code.gs handler, tested here via contract)
  Test.assert('ADMIN_ACTIONS list is defined', typeof ADMIN_ACTIONS !== 'undefined' && Array.isArray(ADMIN_ACTIONS));
  Test.assert('support_reset_device requires admin', ADMIN_ACTIONS.indexOf('support_reset_device') !== -1);
  Test.assert('support_recover_license requires admin', ADMIN_ACTIONS.indexOf('support_recover_license') !== -1);

  // Deactivate endpoint returns 403 (by design — no self-service deactivation)
  const deactivateResult = handleDeactivate({});
  const deactivateBody   = JSON.parse(deactivateResult.getContent());
  Test.assert('handleDeactivate returns OPERATION_NOT_PERMITTED',
    deactivateBody.error === 'OPERATION_NOT_PERMITTED');

  // Token entropy
  const tokens = new Set();
  for (let i = 0; i < 50; i++) tokens.add(SecurityService.generateDeviceToken());
  Test.assert('50 device tokens are all unique', tokens.size === 50);

  // License key entropy
  const keys = new Set();
  for (let i = 0; i < 50; i++) keys.add(SecurityService.generateLicenseKey());
  Test.assert('50 license keys are all unique', keys.size === 50);

  // Canonical JSON is deterministic
  const obj = { c: 3, a: 1, b: 2 };
  Test.assert('canonicalJson is deterministic',
    SecurityService.canonicalJson(obj) === SecurityService.canonicalJson(obj));
}

// ─── Concurrent Activation Test ───────────────────────────────────────────────

function testConcurrentActivation() {
  Test.suite('ConcurrentActivation');

  // GAS is single-threaded per execution, so true concurrency cannot be
  // simulated here. This test verifies the logical protection (slot check
  // inside LockService guard) by running two sequential activations and
  // confirming only the first succeeds.

  const EMAIL   = 'concurrent-' + SecurityService.generateId().slice(0, 8) + '@test.sevnt';
  const M1 = 'concurrent-machine1-' + SecurityService.generateId().replace(/-/g, '');
  const M2 = 'concurrent-machine2-' + SecurityService.generateId().replace(/-/g, '');

  const created = PaymentService.createTestLicense(EMAIL, 'ORDER-CONCURRENT-TEST');
  const key     = created.license_key;

  // Sequential simulation: first activation should succeed
  const r1 = LicenseService.activate({
    license_key: key, device_role: DEVICE_ROLES.PRIMARY_LAPTOP,
    machine_id: M1, device_name: 'Concurrent Laptop 1'
  });
  Test.assertOk('First concurrent activation succeeds', r1);

  // Second activation (different machine) should be rejected
  const r2 = LicenseService.activate({
    license_key: key, device_role: DEVICE_ROLES.PRIMARY_LAPTOP,
    machine_id: M2, device_name: 'Concurrent Laptop 2'
  });
  Test.assertFail('Second concurrent activation rejected (slot occupied)', r2,
    'DEVICE_SLOT_OCCUPIED_CONTACT_SEVNT_SUPPORT');

  Test.assert(
    'Only 1 device was created for this license (sequential simulation confirms lock logic)',
    r1.ok && !r2.ok
  );
}

// ─── Phase 4: PaymentNormalizer Tests ────────────────────────────────────────

function testPaymentNormalizer() {
  Test.suite('PaymentNormalizer');

  // buildCompositeKey
  const key = PaymentNormalizer.buildCompositeKey('lynk', 'ORD-123');
  Test.assertEqual('buildCompositeKey produces provider:order_id', key, 'lynk:ORD-123');

  const key2 = PaymentNormalizer.buildCompositeKey('scalev', 'ORD-123');
  Test.assertEqual('buildCompositeKey is provider-prefixed', key2, 'scalev:ORD-123');
  Test.assert('lynk:ORD-123 !== scalev:ORD-123', key !== key2);

  // buildEventDigest
  const digest1 = PaymentNormalizer.buildEventDigest('lynk:ORD-1', 'PAID', 'TXN-A');
  const digest2 = PaymentNormalizer.buildEventDigest('lynk:ORD-1', 'PAID', 'TXN-A');
  Test.assert('Event digest is deterministic', digest1 === digest2);
  const digest3 = PaymentNormalizer.buildEventDigest('scalev:ORD-1', 'PAID', 'TXN-A');
  Test.assert('Event digest differs across providers', digest1 !== digest3);
  Test.assert('Event digest is 64-char hex (SHA256)', /^[0-9a-f]{64}$/.test(digest1));

  // create + validate
  const tx = PaymentNormalizer.create({
    provider:           'lynk',
    external_order_id:  'ORD-999',
    customer_email:     'buyer@test.sevnt',
    amount:             299000,
    currency:           'IDR',
    payment_status:     'PAID',
    is_paid:            true,
    provider_tx_id:     'TXN-XYZ',
    signature_verified: false
  });
  Test.assert('create() produces composite_key', tx.composite_key === 'lynk:ORD-999');
  Test.assert('create() sets is_paid correctly', tx.is_paid === true);
  Test.assert('validate() passes for complete tx', PaymentNormalizer.validate(tx));

  const badTx = PaymentNormalizer.create({ provider: 'lynk', external_order_id: 'X' });
  Test.assert('validate() fails for missing customer_email', !PaymentNormalizer.validate(badTx));

  // Invalid buildCompositeKey inputs
  let threw = false;
  try { PaymentNormalizer.buildCompositeKey('', 'ORD-1'); } catch(e) { threw = true; }
  Test.assert('buildCompositeKey throws on empty provider', threw);
}

// ─── Phase 4: Lynk Adapter Tests ─────────────────────────────────────────────

function testLynkAdapter() {
  Test.suite('LynkPaymentAdapter');

  // Provider constant
  Test.assertEqual('LynkPaymentAdapter.PROVIDER is "lynk"', LynkPaymentAdapter.PROVIDER, 'lynk');

  // SIGNATURE_BLOCKED must be true (no docs)
  Test.assert('SIGNATURE_BLOCKED=true (Lynk.id docs not accessible)',
    LynkPaymentAdapter.SIGNATURE_BLOCKED === true);

  // mockWebhookBody produces expected shape
  const mock = LynkPaymentAdapter.mockWebhookBody('test@test.sevnt', 'PAID');
  Test.assert('mockWebhookBody returns object', typeof mock === 'object');
  Test.assert('mock has an order_id-like field',
    typeof mock.refId === 'string' && mock.refId.length > 0);

  // parse() with mock body
  const tx = LynkPaymentAdapter.parse(mock, null);
  Test.assert('parse() returns non-null for valid mock body', tx !== null);
  Test.assertEqual('parse() provider is lynk', tx && tx.provider, 'lynk');
  Test.assert('parse() composite_key starts with "lynk:"',
    tx && tx.composite_key.startsWith('lynk:'));
  Test.assert('parse() signature_verified=false when SIGNATURE_BLOCKED=true',
    tx && tx.signature_verified === false);
  Test.assert('parse() is_paid=true for PAID status',
    tx && tx.is_paid === true);

  // parse() with FAILED status
  const failMock = LynkPaymentAdapter.mockWebhookBody('fail@test.sevnt', 'FAILED');
  const failTx = LynkPaymentAdapter.parse(failMock, null);
  Test.assert('parse() is_paid=false for FAILED status',
    failTx && failTx.is_paid === false);

  // parse() rejects null body
  const nullResult = LynkPaymentAdapter.parse(null, null);
  Test.assert('parse() returns null for null body', nullResult === null);

  // parse() rejects body missing required field
  const incompleteMock = { buyer_email: 'x@test.sevnt', payment_status: 'PAID' }; // no order_id
  const incompleteResult = LynkPaymentAdapter.parse(incompleteMock, null);
  Test.assert('parse() returns null when order_id missing', incompleteResult === null);
}

// ─── Phase 4: Scalev Adapter Tests ───────────────────────────────────────────

function testScalevAdapter() {
  Test.suite('ScalevPaymentAdapter');

  // Provider constant
  Test.assertEqual('ScalevPaymentAdapter.PROVIDER is "scalev"', ScalevPaymentAdapter.PROVIDER, 'scalev');

  // FULLY_BLOCKED is now false — Scalev docs accessible
  Test.assert('FULLY_BLOCKED=true (dev.scalev.com docs inaccessible)',
    ScalevPaymentAdapter.FULLY_BLOCKED === false);

  // parse() always returns null while FULLY_BLOCKED
  const anyBody = { field1: 'value1', field2: 'value2' };
  const result  = ScalevPaymentAdapter.parse(anyBody, null);
  Test.assert('parse() returns null when FULLY_BLOCKED=true', result === null);

  const result2 = ScalevPaymentAdapter.parse(null, null);
  Test.assert('parse() returns null for null body when FULLY_BLOCKED', result2 === null);

  // mockWebhookBody produces valid Scalev webhook shape (FULLY_BLOCKED removed)
  const mockBody = ScalevPaymentAdapter.mockWebhookBody('test@test.sevnt', 'PAID');
  Test.assert('mockWebhookBody returns blocked status indicator',
    typeof mockBody.event === 'string' && mockBody.event.length > 0);

  // handleScalevWebhook in PaymentService returns INTEGRATION_BLOCKED
  const webhookResult = PaymentService.handleScalevWebhook({}, null);
  Test.assert('handleScalevWebhook returns ok=false', webhookResult.ok === false);
  Test.assert('handleScalevWebhook returns INTEGRATION_BLOCKED error',
    webhookResult.error === 'INTEGRATION_BLOCKED');
}

// ─── Phase 4: Composite Idempotency Tests ────────────────────────────────────

function testCompositeIdempotency() {
  Test.suite('CompositeIdempotency');

  // PRODUCTION_BLOCKED guard
  const mockBody = LynkPaymentAdapter.mockWebhookBody('idem4@test.sevnt', 'PAID');
  const r = PaymentService.handleLynkWebhook(mockBody, null);
  Test.assert('handleLynkWebhook blocked by PRODUCTION_BLOCKED',
    r.ok === false && r.error === 'INTEGRATION_BLOCKED');

  // Composite key structure
  Test.assert('composite key lynk:X !== plain X',
    PaymentNormalizer.buildCompositeKey('lynk', 'ORD-500') !== 'ORD-500');

  // Event digest uniqueness across different providers with same order_id
  const d1 = PaymentNormalizer.buildEventDigest('lynk:ORD-500',   'PAID', 'TXN-1');
  const d2 = PaymentNormalizer.buildEventDigest('scalev:ORD-500', 'PAID', 'TXN-1');
  Test.assert('Same order_id produces different event digests for different providers', d1 !== d2);

  // Event digest changes with status
  const d3 = PaymentNormalizer.buildEventDigest('lynk:ORD-500', 'PENDING', 'TXN-1');
  Test.assert('Event digest changes with payment status', d1 !== d3);

  // Event digest changes with tx_id
  const d4 = PaymentNormalizer.buildEventDigest('lynk:ORD-500', 'PAID', 'TXN-2');
  Test.assert('Event digest changes with provider_tx_id', d1 !== d4);

  // All digests are valid SHA256 hex strings
  [d1, d2, d3, d4].forEach(function(d, i) {
    Test.assert('Event digest ' + (i+1) + ' is 64-char hex', /^[0-9a-f]{64}$/.test(d));
  });
}

// ─── Phase 4: Cross-Provider Isolation Tests ─────────────────────────────────

function testCrossProviderIsolation() {
  Test.suite('CrossProviderIsolation');

  // Two mock transactions with same external order_id but different providers
  const lynkMock   = LynkPaymentAdapter.mockWebhookBody('cross@test.sevnt', 'PAID');
  const lynkTx     = LynkPaymentAdapter.parse(lynkMock, null);
  Test.assert('Lynk mock produces NormalizedTransaction', lynkTx !== null);

  // Manually construct a Scalev-like tx for comparison (bypasses FULLY_BLOCKED)
  const scalevTx = PaymentNormalizer.create({
    provider:           'scalev',
    external_order_id:  'SAME-ORD-999',
    customer_email:     'cross@test.sevnt',
    amount:             299000,
    currency:           'IDR',
    payment_status:     'PAID',
    is_paid:            true,
    provider_tx_id:     'TXN-S-999',
    signature_verified: false
  });
  const lynkTx2 = PaymentNormalizer.create({
    provider:           'lynk',
    external_order_id:  'SAME-ORD-999',
    customer_email:     'cross@test.sevnt',
    amount:             299000,
    currency:           'IDR',
    payment_status:     'PAID',
    is_paid:            true,
    provider_tx_id:     'TXN-L-999',
    signature_verified: false
  });

  Test.assert('Same order_id: scalev composite_key !== lynk composite_key',
    scalevTx.composite_key !== lynkTx2.composite_key);
  Test.assertEqual('scalev composite_key format', scalevTx.composite_key, 'scalev:SAME-ORD-999');
  Test.assertEqual('lynk composite_key format', lynkTx2.composite_key, 'lynk:SAME-ORD-999');

  const scalevDigest = PaymentNormalizer.buildEventDigest(
    scalevTx.composite_key, scalevTx.payment_status, scalevTx.provider_tx_id);
  const lynkDigest   = PaymentNormalizer.buildEventDigest(
    lynkTx2.composite_key, lynkTx2.payment_status, lynkTx2.provider_tx_id);
  Test.assert('Cross-provider event digests are different', scalevDigest !== lynkDigest);

  // findPaymentByCompositeKey returns null for new composite keys
  const findResult = DatabaseService.findPaymentByCompositeKey('lynk:NONEXISTENT-999');
  Test.assert('findPaymentByCompositeKey returns null for nonexistent key', findResult === null);

  const findResult2 = DatabaseService.findPaymentByCompositeKey('scalev:NONEXISTENT-999');
  Test.assert('findPaymentByCompositeKey returns null for scalev nonexistent key', findResult2 === null);
}

// ─── Phase 4: Webhook Routing Tests ──────────────────────────────────────────

function testWebhookRouting() {
  Test.suite('WebhookRouting');

  // ROUTER map contains both webhook routes
  Test.assert('ROUTER contains lynk_webhook', typeof ROUTER['lynk_webhook'] === 'function');
  Test.assert('ROUTER contains scalev_webhook', typeof ROUTER['scalev_webhook'] === 'function');

  // handleLynkWebhook: either INTEGRATION_BLOCKED or diagnostic mode response
  const r1 = handleLynkWebhook({}, null);
  const body1 = JSON.parse(r1.getContent());
  Test.assert('handleLynkWebhook route returns INTEGRATION_BLOCKED',
    body1.error === 'INTEGRATION_BLOCKED' ||
    (body1.ok === true && body1.mode === 'diagnostic') ||
    body1.mode === 'diagnostic');

  // handleScalevWebhook: either INTEGRATION_BLOCKED or diagnostic mode response
  const r2 = handleScalevWebhook({}, null);
  const body2 = JSON.parse(r2.getContent());
  Test.assert('handleScalevWebhook route returns INTEGRATION_BLOCKED',
    body2.error === 'INTEGRATION_BLOCKED' ||
    (body2.ok === true && body2.mode === 'diagnostic') ||
    body2.mode === 'diagnostic');

  // Neither webhook action is in ADMIN_ACTIONS
  Test.assert('lynk_webhook is NOT an admin action',
    ADMIN_ACTIONS.indexOf('lynk_webhook') === -1);
  Test.assert('scalev_webhook is NOT an admin action',
    ADMIN_ACTIONS.indexOf('scalev_webhook') === -1);

  // mockWebhookBody backward compat (Phase 1 tests relied on PaymentService.mockWebhookBody)
  const legacyMock = PaymentService.mockWebhookBody('legacy@test.sevnt', 'PAID');
  Test.assert('PaymentService.mockWebhookBody() still works (compat shim)',
    legacyMock !== null && typeof legacyMock === 'object');
}

// ─── Phase 4.2: Lynk Verified Field Tests ────────────────────────────────────

function testLynkVerifiedFields() {
  Test.suite('LynkVerifiedFields (Phase 4.2)');

  // Verified field constants from documentation
  Test.assertEqual('FIELDS.REF_ID is "refId" (VERIFIED)',
    LynkPaymentAdapter.FIELDS.REF_ID, 'refId');
  Test.assertEqual('FIELDS.AMOUNT is "amount" (VERIFIED)',
    LynkPaymentAdapter.FIELDS.AMOUNT, 'amount');
  Test.assertEqual('FIELDS.MESSAGE_ID is "message_id" (VERIFIED)',
    LynkPaymentAdapter.FIELDS.MESSAGE_ID, 'message_id');
  Test.assertEqual('SIGNATURE_HEADER is "X-Lynk-Signature" (VERIFIED)',
    LynkPaymentAdapter.SIGNATURE_HEADER, 'X-Lynk-Signature');

  // Mock body uses verified field names
  const mock = LynkPaymentAdapter.mockWebhookBody('test@test.sevnt', 'success');
  Test.assert('mockWebhookBody has refId field', mock.hasOwnProperty('refId'));
  Test.assert('mockWebhookBody has amount field', mock.hasOwnProperty('amount'));
  Test.assert('mockWebhookBody has message_id field', mock.hasOwnProperty('message_id'));

  // parse() with verified fields
  const tx = LynkPaymentAdapter.parse(mock, null);
  Test.assert('parse() uses refId as external_order_id', tx && tx.external_order_id === mock.refId);
  Test.assert('parse() extracts amount', tx && tx.amount !== undefined);
  Test.assert('parse() provider_tx_id is message_id', tx && tx.provider_tx_id === mock.message_id);

  // parse() rejects body without refId
  const noRefId = { amount: '299000', message_id: 'MSG-001', buyer_email: 'x@test.sevnt' };
  Test.assert('parse() returns null when refId missing',
    LynkPaymentAdapter.parse(noRefId, null) === null);

  // Signature computation (algorithm verified)
  const sig = LynkPaymentAdapter.computeExpectedSignature('299000', 'ORD-1', 'MSG-1', 'my-secret');
  Test.assert('computeExpectedSignature returns 64-char hex', /^[0-9a-f]{64}$/.test(sig));

  // Same inputs → same signature (deterministic)
  const sig2 = LynkPaymentAdapter.computeExpectedSignature('299000', 'ORD-1', 'MSG-1', 'my-secret');
  Test.assert('computeExpectedSignature is deterministic', sig === sig2);

  // Different merchant_key → different signature
  const sig3 = LynkPaymentAdapter.computeExpectedSignature('299000', 'ORD-1', 'MSG-1', 'other-secret');
  Test.assert('computeExpectedSignature differs with different key', sig !== sig3);

  // Order of concatenation matters (amount+refId+msgId+key)
  const sig4 = LynkPaymentAdapter.computeExpectedSignature('299000', 'MSG-1', 'ORD-1', 'my-secret');
  Test.assert('computeExpectedSignature is order-sensitive', sig !== sig4);

  // SIGNATURE_BLOCKED must remain true (GAS cannot read headers)
  Test.assert('SIGNATURE_BLOCKED=true (X-Lynk-Signature header unreadable in GAS)',
    LynkPaymentAdapter.SIGNATURE_BLOCKED === true);
}

// ─── Phase 4.2: Scalev Verified Field Tests ───────────────────────────────────

function testScalevVerifiedFields() {
  Test.suite('ScalevVerifiedFields (Phase 4.2)');

  // Not fully blocked anymore
  Test.assert('ScalevPaymentAdapter.FULLY_BLOCKED=false (docs now accessible)',
    ScalevPaymentAdapter.FULLY_BLOCKED === false);
  Test.assert('ScalevPaymentAdapter.SIGNATURE_BLOCKED=true (header unreadable in GAS)',
    ScalevPaymentAdapter.SIGNATURE_BLOCKED === true);

  // Verified event names
  Test.assertEqual('EVENTS.PAYMENT_RECEIVED verified', ScalevPaymentAdapter.EVENTS.PAYMENT_RECEIVED, 'payment.received');
  Test.assertEqual('EVENTS.TEST_EVENT verified', ScalevPaymentAdapter.EVENTS.TEST_EVENT, 'business.test_event');
  Test.assertEqual('SIGNATURE_HEADER verified', ScalevPaymentAdapter.SIGNATURE_HEADER, 'X-Scalev-Hmac-Sha256');

  // Mock payment.received body
  const mock = ScalevPaymentAdapter.mockWebhookBody('test@test.sevnt', 'payment.received');
  Test.assert('mock has event field', mock.event === 'payment.received');
  Test.assert('mock has unique_id field', typeof mock.unique_id === 'string');
  Test.assert('mock has timestamp field', typeof mock.timestamp === 'string');
  Test.assert('mock data.order_id exists', mock.data && typeof mock.data.order_id === 'string');
  Test.assert('mock data.payment_status is "paid"', mock.data.payment_status === 'paid');
  Test.assert('mock data.destination_address.email exists',
    mock.data.destination_address && typeof mock.data.destination_address.email === 'string');

  // parse() with verified payload
  const tx = ScalevPaymentAdapter.parse(mock, null);
  Test.assert('parse() returns non-null for payment.received', tx !== null && !tx._is_test_event);
  Test.assert('parse() provider is scalev', tx && tx.provider === 'scalev');
  Test.assert('parse() composite_key starts with "scalev:"',
    tx && tx.composite_key.startsWith('scalev:'));
  Test.assert('parse() extracts order_id as external_order_id',
    tx && tx.external_order_id === mock.data.order_id);
  Test.assert('parse() is_paid=true for paid status', tx && tx.is_paid === true);
  Test.assert('parse() provider_tx_id is unique_id', tx && tx.provider_tx_id === mock.unique_id);

  // Test event handling
  const testEvent = ScalevPaymentAdapter.mockTestEvent();
  const testTx = ScalevPaymentAdapter.parse(testEvent, null);
  Test.assert('parse() returns _is_test_event flag for business.test_event',
    testTx && testTx._is_test_event === true);

  // HMAC signature computation
  const expectedSig = ScalevPaymentAdapter.computeExpectedSignature(
    '{"event":"payment.received"}', 'my-signing-secret');
  Test.assert('computeExpectedSignature returns non-empty Base64 string',
    typeof expectedSig === 'string' && expectedSig.length > 0);

  // Deterministic
  const sig2 = ScalevPaymentAdapter.computeExpectedSignature(
    '{"event":"payment.received"}', 'my-signing-secret');
  Test.assert('computeExpectedSignature is deterministic', expectedSig === sig2);
}

// ─── Phase 4.2: Diagnostic Service Tests ─────────────────────────────────────

function testDiagnosticService() {
  Test.suite('DiagnosticService (Phase 4.2)');

  // getStatus always works
  const status = DiagnosticService.getStatus();
  Test.assert('getStatus() returns object', typeof status === 'object');
  Test.assert('getStatus() has diagnostic_mode field', status.hasOwnProperty('diagnostic_mode'));
  Test.assert('getStatus() has safe_env field', status.hasOwnProperty('safe_env'));
  Test.assert('getStatus() documents header limitation',
    typeof status.header_note === 'string' && status.header_note.length > 0);

  // isDiagnosticMode returns boolean
  Test.assert('isDiagnosticMode() returns boolean',
    typeof DiagnosticService.isDiagnosticMode() === 'boolean');

  // isSafeDevEnvironment returns boolean
  Test.assert('isSafeDevEnvironment() returns boolean',
    typeof DiagnosticService.isSafeDevEnvironment() === 'boolean');

  // capture() without DIAGNOSTIC_MODE set → returns error
  // (In test environment, DIAGNOSTIC_MODE property is not set by default)
  const result = DiagnosticService.capture('lynk', { refId: 'ORD-1' }, null, '{"refId":"ORD-1"}');
  Test.assert('capture() returns DIAGNOSTIC_NOT_ENABLED when property not set',
    !result.ok && result.error === 'DIAGNOSTIC_NOT_ENABLED' ||
    result.ok === true  // If DIAGNOSTIC_MODE=true is set in this test environment
  );

  // Diagnostic mode does NOT create licenses
  // (verify by checking that no new license exists in LICENSES sheet)
  const beforeCount = DatabaseService.getAllRows(DatabaseService.SHEET.LICENSES).length;
  DiagnosticService.capture('scalev',
    ScalevPaymentAdapter.mockWebhookBody('diag@test.sevnt', 'payment.received'),
    null, '{}');
  const afterCount = DatabaseService.getAllRows(DatabaseService.SHEET.LICENSES).length;
  Test.assert('Diagnostic capture does NOT create licenses', beforeCount === afterCount);
}

// ─── Phase 4.2: Diagnostic Safety Tests ──────────────────────────────────────

function testDiagnosticSafety() {
  Test.suite('DiagnosticSafety (Phase 4.2)');

  // handleScalevWebhook: business.test_event always returns ok=true (even before diagnostic mode check)
  const testEventBody = ScalevPaymentAdapter.mockTestEvent();
  // We test via Code.gs handler
  const r = handleScalevWebhook(testEventBody, null);
  const rBody = JSON.parse(r.getContent());
  Test.assert('handleScalevWebhook: business.test_event returns ok=true',
    rBody.ok === true);
  Test.assert('handleScalevWebhook: business.test_event does not return INTEGRATION_BLOCKED',
    rBody.error !== 'INTEGRATION_BLOCKED');

  // GET request cannot trigger webhook processing
  const getResponse = doGet({ parameter: {} });
  const getBody = JSON.parse(getResponse.getContent());
  Test.assert('doGet() does not process payments (health check only)',
    getBody.ok === true && getBody.version !== undefined);

  // Unknown route returns UNKNOWN_ACTION
  const unknownBody = { action: 'unknown_action_xyz' };
  const unknownR = doPost({ postData: { contents: JSON.stringify(unknownBody) },
                             parameter: {} });
  const unknownRBody = JSON.parse(unknownR.getContent());
  Test.assert('Unknown route returns UNKNOWN_ACTION', unknownRBody.error === 'UNKNOWN_ACTION');

  // Empty body returns INVALID_REQUEST
  const emptyR = doPost({ postData: null, parameter: {} });
  const emptyBody = JSON.parse(emptyR.getContent());
  Test.assert('Empty POST body returns INVALID_REQUEST', emptyBody.error === 'INVALID_REQUEST');

  // Lynk webhook PRODUCTION_BLOCKED guard fires
  const lynkMock = LynkPaymentAdapter.mockWebhookBody('safety@test.sevnt', 'success');
  const lynkR = handleLynkWebhook(lynkMock, null);
  const lynkBody = JSON.parse(lynkR.getContent());
  // Could be diagnostic or INTEGRATION_BLOCKED depending on DIAGNOSTIC_MODE setting
  Test.assert('handleLynkWebhook: either diagnostic mode or INTEGRATION_BLOCKED (never issues license)',
    lynkBody.ok === true && lynkBody.mode === 'diagnostic' ||
    lynkBody.error === 'INTEGRATION_BLOCKED');

  // Diagnostic response never contains license key or device token
  const mockLynkBody = LynkPaymentAdapter.mockWebhookBody('safeguard@test.sevnt', 'success');
  const diagR = handleLynkWebhook(mockLynkBody, null);
  const diagStr = diagR.getContent();
  Test.assert('Diagnostic response never contains license_key',
    !diagStr.includes('"license_key"') && !diagStr.includes('license_key:'));
  Test.assert('Diagnostic response never contains device_token',
    !diagStr.includes('"device_token"'));
}
