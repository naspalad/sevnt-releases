/**
 * PaymentService — Provider-agnostic payment webhook processor.
 *
 * PHASE 4 ARCHITECTURE:
 *   Webhook body → Adapter (Lynk/Scalev) → NormalizedTransaction
 *   → PaymentService._processNormalized() → License creation
 *
 * STATUS SUMMARY (2026-11-09):
 *   - Lynk.id adapter:  SIGNATURE_BLOCKED (docs not publicly accessible)
 *   - Scalev adapter:   FULLY_BLOCKED (dev.scalev.com sub-pages all return 404)
 *   - PRODUCTION_BLOCKED = true guards all live processing
 *
 * Idempotency key: provider + ':' + external_order_id  (e.g. 'lynk:ORD-123')
 * Event digest:    SHA256(composite_key + ':' + status + ':' + provider_tx_id)
 *
 * Both keys include provider name, preventing cross-provider collisions.
 * A PAID event from lynk:ORD-1 and scalev:ORD-1 are entirely independent records.
 */

const PaymentService = (function() {

  // Guards ALL live webhook processing until adapters are verified and unblocked
  const PRODUCTION_BLOCKED = false;

  // ─── Webhook Handlers ─────────────────────────────────────────────────────

  /**
   * Handle incoming Lynk.id webhook.
   * Delegates parse+normalize to LynkPaymentAdapter, then processes.
   *
   * @param {Object} body - Parsed request body
   * @param {Object} e    - Apps Script event (for headers)
   * @returns {{ ok: boolean, error?: string, message?: string }}
   */
  function handleLynkWebhook(body, e, proxyMeta) {
    if (PRODUCTION_BLOCKED) {
      Logger.log('PAYMENT: handleLynkWebhook called but PRODUCTION_BLOCKED=true.');
      AuditService.log('PAYMENT_RECEIVED', null, null, 'system', 'FAILURE',
        { reason: 'PRODUCTION_BLOCKED', provider: 'lynk', body_keys: Object.keys(body || {}) });
      return {
        ok: false,
        error: 'INTEGRATION_BLOCKED',
        message: 'Lynk.id integration is pending documentation verification. ' +
                 'Contact SEVNT admin to enable production webhook processing.'
      };
    }

    if (LynkPaymentAdapter.SIGNATURE_BLOCKED) {
      Logger.log('PAYMENT: Lynk adapter SIGNATURE_BLOCKED — cannot process live webhooks.');
      return {
        ok: false,
        error: 'SIGNATURE_VERIFICATION_BLOCKED',
        message: 'Lynk.id signature verification is not yet implemented.'
      };
    }

    const tx = LynkPaymentAdapter.parse(body, e, proxyMeta);
    if (!tx) {
      return { ok: false, error: 'PARSE_ERROR', message: 'Failed to parse Lynk.id webhook body' };
    }

    if (!PaymentNormalizer.validate(tx)) {
      return { ok: false, error: 'INVALID_TRANSACTION', message: 'Normalized transaction failed validation' };
    }

    return _processNormalized(tx);
  }

  /**
   * Handle incoming Scalev webhook.
   *
   * STATUS: FULLY_BLOCKED — Scalev docs inaccessible (all sub-pages 404).
   *
   * @param {Object} body
   * @param {Object} e
   * @returns {{ ok: boolean, error: string, message: string }}
   */
  function handleScalevWebhook(body, e) {
    // Note: business.test_event is handled in Code.gs BEFORE reaching this function
    // to ensure 2xx is returned regardless of PRODUCTION_BLOCKED state

    if (PRODUCTION_BLOCKED) {
      Logger.log('PAYMENT: handleScalevWebhook called but PRODUCTION_BLOCKED=true.');
      AuditService.log('PAYMENT_RECEIVED', null, null, 'system', 'FAILURE',
        { reason: 'PRODUCTION_BLOCKED', provider: 'scalev',
          event: (body && body.event) || 'unknown' });
      return {
        ok: false,
        error: 'INTEGRATION_BLOCKED',
        message: 'Scalev integration is pending production enablement. ' +
                 'PRODUCTION_BLOCKED=true. Contact SEVNT admin.'
      };
    }

    if (ScalevPaymentAdapter.SIGNATURE_BLOCKED) {
      Logger.log('PAYMENT: Scalev adapter SIGNATURE_BLOCKED — cannot process live webhooks.');
      return {
        ok: false,
        error: 'SIGNATURE_VERIFICATION_BLOCKED',
        message: 'Scalev signature verification not implementable in GAS — X-Scalev-Hmac-Sha256 header unreadable. ' +
                 'Requires middleware layer. See PHASE4.2-REPORT.md Section 5.'
      };
    }

    const tx = ScalevPaymentAdapter.parse(body, e);
    if (!tx) {
      return { ok: false, error: 'PARSE_ERROR', message: 'Failed to parse Scalev webhook body' };
    }

    // Test event should not reach here (handled in Code.gs) but guard anyway
    if (tx._is_test_event) {
      return { ok: true, message: 'Test event acknowledged' };
    }

    if (!PaymentNormalizer.validate(tx)) {
      return { ok: false, error: 'INVALID_TRANSACTION', message: 'Normalized transaction failed validation' };
    }

    return _processNormalized(tx);
  }

  // ─── Core Processing ──────────────────────────────────────────────────────

  /**
   * Process a NormalizedTransaction — provider-agnostic.
   *
   * Idempotency is enforced at two levels:
   *   1. event_digest: exact dedup of same event (same order + status + tx_id)
   *   2. composite_key: order-level dedup (same order already processed as PAID)
   *
   * @param {NormalizedTransaction} tx
   * @returns {{ ok: boolean, message?: string, error?: string }}
   */
  function _processNormalized(tx) {
    const compositeKey  = tx.composite_key;  // e.g. 'lynk:ORD-123'
    const eventDigest   = PaymentNormalizer.buildEventDigest(
                            compositeKey, tx.payment_status, tx.provider_tx_id);

    // Level 1: Event-level idempotency
    const existingEvent = DatabaseService.findPaymentByEventDigest(eventDigest);
    if (existingEvent) {
      Logger.log('PAYMENT: Duplicate event ignored. composite_key=' + compositeKey);
      return { ok: true, message: 'Duplicate event acknowledged' };
    }

    // Level 2: Order-level idempotency (already processed as PAID)
    const existingPayment = DatabaseService.findPaymentByCompositeKey(compositeKey);
    if (existingPayment && existingPayment.payment_status === PAYMENT_STATUS.PAID) {
      Logger.log('PAYMENT: Order already PAID. composite_key=' + compositeKey);
      return { ok: true, message: 'Order already processed' };
    }

    // Record payment event
    const now = new Date().toISOString();
    if (!existingPayment) {
      DatabaseService.createPayment({
        order_id:                compositeKey,       // composite key stored as order_id
        provider:                tx.provider,
        provider_transaction_id: tx.provider_tx_id,
        customer_email:          tx.customer_email,
        amount:                  tx.amount,
        currency:                tx.currency,
        payment_status:          tx.payment_status,
        received_at:             now,
        processed_at:            '',
        license_id:              '',
        event_digest:            eventDigest
      });
    }

    if (!tx.is_paid) {
      Logger.log('PAYMENT: Non-paid status recorded. composite_key=' + compositeKey +
                 ' status=' + tx.payment_status);
      AuditService.log('PAYMENT_RECEIVED', null, null, 'system', 'SUCCESS',
        { composite_key: compositeKey, status: tx.payment_status, action: 'NO_LICENSE_CREATED' });
      return { ok: true, message: 'Payment event recorded (status: ' + tx.payment_status + ')' };
    }

    return _createLicenseForPayment(compositeKey, tx.customer_email, now);
  }

  /**
   * Create a license for a confirmed payment.
   * Acquires ScriptLock to prevent duplicate license creation from concurrent retries.
   *
   * @param {string} compositeKey - e.g. 'lynk:ORD-123'
   * @param {string} email
   * @param {string} now - ISO8601 timestamp
   */
  function _createLicenseForPayment(compositeKey, email, now) {
    const lock = LockService.getScriptLock();
    try {
      lock.waitLock(15000);
    } catch (lockErr) {
      return { ok: false, error: 'SERVER_BUSY', message: 'Server busy — provider may retry' };
    }

    try {
      // Re-check inside lock to handle concurrent retries
      const existing = DatabaseService.findPaymentByCompositeKey(compositeKey);
      if (existing && existing.license_id) {
        return { ok: true, message: 'License already created for this order' };
      }

      const licenseKey     = SecurityService.generateLicenseKey();
      const licenseKeyHash = SecurityService.hashLicenseKey(licenseKey);
      const licenseId      = SecurityService.generateId();

      DatabaseService.createLicense({
        license_id:         licenseId,
        license_key_hash:   licenseKeyHash,
        license_key_prefix: SecurityService.licenseKeyPrefix(licenseKey),
        customer_email:     email,
        order_id:           compositeKey,
        status:             LICENSE_STATUS.ACTIVE,
        payment_status:     PAYMENT_STATUS.PAID,
        created_at:         now,
        updated_at:         now,
        notes:              'Created via webhook: ' + compositeKey
      });

      // Update payment record with license_id
      const payment = DatabaseService.findPaymentByCompositeKey(compositeKey);
      if (payment) {
        DatabaseService.updatePayment(payment._rowIndex, {
          license_id:     licenseId,
          processed_at:   now,
          payment_status: PAYMENT_STATUS.PAID
        });
      }

      EmailService.queueLicenseDelivery(licenseId, email, licenseKey);

      AuditService.log(AuditService.EVENT_TYPE.LICENSE_CREATED,
        licenseId, null, 'system', 'SUCCESS',
        { composite_key: compositeKey, trigger: 'webhook' });

      return { ok: true, message: 'License created and queued for delivery' };

    } finally {
      lock.releaseLock();
    }
  }

  // ─── Testing Helpers ──────────────────────────────────────────────────────

  /**
   * Direct license creation for testing without a live webhook.
   * NOT exposed as public API endpoint.
   * Used only by TestRunner and admin setup.
   *
   * @param {string} email
   * @param {string} orderId - Raw order reference (will be stored as-is, no provider prefix)
   * @returns {{ ok: boolean, license_id: string, license_key: string }}
   */
  function createTestLicense(email, orderId) {
    const now            = new Date().toISOString();
    const licenseKey     = SecurityService.generateLicenseKey();
    const licenseKeyHash = SecurityService.hashLicenseKey(licenseKey);
    const licenseId      = SecurityService.generateId();
    const testOrderId    = orderId || 'TEST-' + licenseId.slice(0, 8);

    DatabaseService.createLicense({
      license_id:         licenseId,
      license_key_hash:   licenseKeyHash,
      license_key_prefix: SecurityService.licenseKeyPrefix(licenseKey),
      customer_email:     email,
      order_id:           testOrderId,
      status:             LICENSE_STATUS.ACTIVE,
      payment_status:     PAYMENT_STATUS.PAID,
      created_at:         now,
      updated_at:         now,
      notes:              'TEST LICENSE — created by TestRunner'
    });

    AuditService.log(AuditService.EVENT_TYPE.LICENSE_CREATED,
      licenseId, null, 'system', 'SUCCESS',
      { trigger: 'test_direct', email: email });

    return { ok: true, license_id: licenseId, license_key: licenseKey };
  }

  /**
   * @deprecated Use LynkPaymentAdapter.mockWebhookBody() instead.
   * Kept for backward compatibility with PHASE 1 tests.
   */
  function mockWebhookBody(email, status) {
    return LynkPaymentAdapter.mockWebhookBody(email, status);
  }

  return {
    handleLynkWebhook:    handleLynkWebhook,
    handleScalevWebhook:  handleScalevWebhook,
    mockWebhookBody:      mockWebhookBody,
    createTestLicense:    createTestLicense,
    PRODUCTION_BLOCKED:   PRODUCTION_BLOCKED
  };

})();
