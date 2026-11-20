/**
 * LynkPaymentAdapter — Lynk.id webhook adapter.
 *
 * DOCUMENTATION SOURCE:
 *   https://documenter.getpostman.com/view/3211564/2sB2cVf2Kp
 *   https://www.lynk.id/faq/detail/6908cd80402bd9e753aa85e0-4149-956987938
 *   Verified: 2026-11-09
 *
 * SIGNATURE MECHANISM (VERIFIED from docs):
 *   Header:    X-Lynk-Signature
 *   Algorithm: SHA256(amount + refId + message_id + merchant_key) → hex string
 *   Key:       merchant_key (from Lynk.id dashboard, available after webhook URL is saved)
 *
 * KNOWN PAYLOAD FIELDS (from Postman docs):
 *   refId       — Lynk.id order/transaction reference ID
 *   amount      — grandTotal (string or number)
 *   message_id  — Lynk.id internal message/event ID (used in signature)
 *
 * ⚠️ GAS HEADER LIMITATION — SIGNATURE BLOCKED:
 *   Apps Script doPost(e) does NOT expose arbitrary HTTP headers.
 *   The X-Lynk-Signature header IS DOCUMENTED but CANNOT BE READ in GAS.
 *   See: https://issuetracker.google.com/issues/36763610
 *
 *   This means _verifySignature() cannot be implemented in pure GAS.
 *   SIGNATURE_BLOCKED remains true until one of:
 *     a) A middleware layer (Cloud Run / Cloud Functions) reads the header
 *        and forwards it as a query param or body field, OR
 *     b) Lynk.id provides a header-less verification method
 *
 * DIAGNOSTIC MODE:
 *   When DiagnosticService.isDiagnosticMode() = true, parse() runs normally
 *   but the result is captured by DiagnosticService, not processed as payment.
 *
 * STATUS: SIGNATURE_BLOCKED (header unreadable in GAS)
 *         FIELD NAMES: VERIFIED from documentation
 */

const LynkPaymentAdapter = (function() {

  const PROVIDER = 'lynk';

  // Signature verification handled by Cloudflare Worker proxy (sevnt-lynk-webhook-dev)
  const SIGNATURE_BLOCKED = false;

  // VERIFIED field names from Lynk.id Postman documentation
  const FIELDS = {
    REF_ID:     'refId',      // VERIFIED — Lynk.id order/transaction reference
    AMOUNT:     'amount',     // VERIFIED — grandTotal (used in signature)
    MESSAGE_ID: 'message_id', // VERIFIED — used in signature computation
    // Additional fields that may be present (to be confirmed by diagnostic capture):
    // buyer_email, payment_status, currency, etc.
  };

  // VERIFIED: status values for successful payment (from Postman docs context)
  // Docs mention "successful transactions" — exact status value TBD from diagnostic
  const PAID_STATUSES = ['success', 'paid', 'PAID', 'SUCCESS', 'completed']; // TBD — confirm via diagnostic

  // VERIFIED: signature header name from Postman docs
  const SIGNATURE_HEADER = 'X-Lynk-Signature'; // VERIFIED — but NOT readable in GAS

  /**
   * Parse and normalize a Lynk.id webhook body.
   *
   * Returns a NormalizedTransaction if body has at minimum refId.
   * Signature verification is BLOCKED (header not readable in GAS).
   *
   * @param {Object} body - Parsed JSON body
   * @param {Object} e    - Apps Script event (headers NOT readable)
   * @returns {NormalizedTransaction|null}
   */
  function parse(body, e, proxyMeta) {
    if (!body) return null;

    // Actual Lynk.id payload structure (confirmed via diagnostic capture 2026-11-20):
    //   body.event                          = "payment.received"
    //   body.data.message_id                = "API_CALL_..."
    //   body.data.message_action            = "SUCCESS"
    //   body.data.message_data.refId        = order reference
    //   body.data.message_data.totals.grandTotal = amount (number)
    //   body.data.message_data.customer.email    = buyer email
    const data        = body.data || {};
    const messageData = data.message_data || {};

    const refId     = messageData.refId     || body[FIELDS.REF_ID];
    const amount    = (messageData.totals && messageData.totals.grandTotal != null)
                        ? messageData.totals.grandTotal
                        : body[FIELDS.AMOUNT];
    const messageId = data.message_id       || body[FIELDS.MESSAGE_ID];
    const email     = (messageData.customer && messageData.customer.email)
                        || body.buyer_email || body.email || body.customer_email || '';
    const rawStatus = data.message_action   || body.payment_status || body.status || '';
    const isPaid    = rawStatus === 'SUCCESS' || PAID_STATUSES.indexOf(rawStatus) !== -1;

    // Signature verified by Cloudflare Worker proxy; falls back to false if no proxy
    const sigVerified = (proxyMeta && proxyMeta.signature_verified === true) ? true : false;

    if (!refId) {
      Logger.log('LynkPaymentAdapter.parse: missing refId');
      return null;
    }

    return PaymentNormalizer.create({
      provider:           PROVIDER,
      external_order_id:  refId,
      customer_email:     email,
      amount:             String(amount),
      currency:           (messageData.totals && messageData.totals.currency) || body.currency || 'IDR',
      payment_status:     rawStatus,
      is_paid:            isPaid,
      provider_tx_id:     messageId || '',
      received_at:        new Date().toISOString(),
      signature_verified: sigVerified
    });
  }

  /**
   * Compute what the signature SHOULD be for a given payload.
   * Used for diagnostic comparison once merchant_key is obtained.
   * NOT used in production path (signature header unreadable in GAS).
   *
   * Algorithm (VERIFIED): SHA256(amount + refId + message_id + merchant_key) → hex
   *
   * @param {string} amount
   * @param {string} refId
   * @param {string} messageId
   * @param {string} merchantKey - from Script Property LYNK_MERCHANT_KEY
   * @returns {string} SHA256 hex digest
   */
  function computeExpectedSignature(amount, refId, messageId, merchantKey) {
    const signatureString = String(amount) + String(refId) + String(messageId) + merchantKey;
    return SecurityService.sha256Hex(signatureString);
  }

  /**
   * Verify signature — BLOCKED in pure GAS.
   * Kept as implementation blueprint for middleware or future GAS capability.
   *
   * To implement when middleware provides header value as body field:
   *   1. Get merchantKey = PropertiesService.getScriptProperties().getProperty('LYNK_MERCHANT_KEY')
   *   2. Compute expected = computeExpectedSignature(amount, refId, messageId, merchantKey)
   *   3. Compare expected === received_signature (from header or proxied field)
   *
   * @returns {boolean} Always false — header not readable in GAS
   */
  function _verifySignature(body, e, receivedSignature) {
    // BLOCKED: X-Lynk-Signature header not readable in Apps Script doPost(e)
    Logger.log('LynkPaymentAdapter._verifySignature: BLOCKED — header not readable in GAS. ' +
               'Requires middleware layer to extract X-Lynk-Signature.');
    return false;
  }

  /**
   * Mock Lynk.id webhook body for testing.
   * Uses VERIFIED field names from Postman documentation.
   *
   * @param {string} email
   * @param {string} status
   * @returns {Object}
   */
  function mockWebhookBody(email, status) {
    const refId     = 'LYNK-' + SecurityService.generateId().slice(0, 8).toUpperCase();
    const amount    = '299000';
    const messageId = 'MSG-' + SecurityService.generateId().slice(0, 8).toUpperCase();
    return {
      [FIELDS.REF_ID]:     refId,
      [FIELDS.AMOUNT]:     amount,
      [FIELDS.MESSAGE_ID]: messageId,
      buyer_email:         email || 'test@example.com', // TBD — may differ in real payload
      payment_status:      status || 'success',          // TBD — confirm via diagnostic
      currency:            'IDR'
      // X-Lynk-Signature header would be:
      // SHA256(amount + refId + messageId + merchantKey)
      // but header is not sendable in body mock
    };
  }

  return {
    PROVIDER:                   PROVIDER,
    SIGNATURE_BLOCKED:          SIGNATURE_BLOCKED,
    FIELDS:                     FIELDS,
    SIGNATURE_HEADER:           SIGNATURE_HEADER,
    parse:                      parse,
    computeExpectedSignature:   computeExpectedSignature,
    mockWebhookBody:            mockWebhookBody
  };

})();
