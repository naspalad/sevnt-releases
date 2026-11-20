/**
 * PaymentNormalizer — Provider-agnostic internal payment contract.
 *
 * Both LynkPaymentAdapter and ScalevPaymentAdapter produce a NormalizedTransaction
 * before it reaches PaymentService. This isolates provider-specific field names
 * from all downstream processing logic.
 *
 * Internal format is NOT a guess — it is defined here and adapters must conform.
 * Provider-specific field names (e.g. 'buyer_email' vs 'customer_email') are NEVER
 * used outside their respective adapter.
 *
 * STATUS: ACTIVE — shared contract usable once adapters are unblocked.
 */

const PaymentNormalizer = (function() {

  /**
   * Canonical internal transaction object.
   * Adapters return this shape (or null on parse failure).
   *
   * @typedef {Object} NormalizedTransaction
   * @property {string} provider         - 'lynk' | 'scalev'
   * @property {string} external_order_id - Provider's order/invoice ID
   * @property {string} composite_key     - provider + ':' + external_order_id
   * @property {string} customer_email
   * @property {number|string} amount
   * @property {string} currency          - e.g. 'IDR'
   * @property {string} payment_status    - raw provider status (not normalized)
   * @property {boolean} is_paid          - true if adapter confirms this is a successful payment
   * @property {string} provider_tx_id    - Provider's internal transaction/reference ID
   * @property {string} received_at       - ISO8601 timestamp when webhook was received
   * @property {boolean} signature_verified - true only if provider signature was checked
   */

  /**
   * Build a composite idempotency key from provider + external order ID.
   * Prevents cross-provider collisions (e.g. lynk:ORD-1 ≠ scalev:ORD-1).
   *
   * @param {string} provider
   * @param {string} externalOrderId
   * @returns {string}
   */
  function buildCompositeKey(provider, externalOrderId) {
    if (!provider || !externalOrderId) {
      throw new Error('buildCompositeKey: provider and externalOrderId are required');
    }
    return provider + ':' + externalOrderId;
  }

  /**
   * Build event digest for idempotency across retries of the same event.
   * Includes composite_key so the same order_id from different providers
   * produces different digests.
   *
   * @param {string} compositeKey
   * @param {string} paymentStatus
   * @param {string} providerTxId
   * @returns {string} SHA256 hex
   */
  function buildEventDigest(compositeKey, paymentStatus, providerTxId) {
    const input = compositeKey + ':' + (paymentStatus || '') + ':' + (providerTxId || '');
    return SecurityService.sha256Hex(input);
  }

  /**
   * Validate that an adapter-produced object has all required fields.
   * Returns true if valid, false otherwise (logs missing field).
   *
   * @param {NormalizedTransaction} tx
   * @returns {boolean}
   */
  function validate(tx) {
    if (!tx) return false;
    const required = ['provider', 'external_order_id', 'composite_key',
                      'customer_email', 'payment_status', 'received_at'];
    for (var i = 0; i < required.length; i++) {
      if (!tx[required[i]]) {
        Logger.log('PaymentNormalizer.validate: missing field: ' + required[i]);
        return false;
      }
    }
    if (!tx.customer_email.includes('@')) {
      Logger.log('PaymentNormalizer.validate: invalid email format');
      return false;
    }
    return true;
  }

  /**
   * Create a NormalizedTransaction — used by adapters to build a conforming object.
   *
   * @param {Object} fields
   * @returns {NormalizedTransaction}
   */
  function create(fields) {
    const provider        = fields.provider || '';
    const externalOrderId = fields.external_order_id || '';
    return {
      provider:            provider,
      external_order_id:   externalOrderId,
      composite_key:       buildCompositeKey(provider, externalOrderId),
      customer_email:      fields.customer_email || '',
      amount:              fields.amount !== undefined ? fields.amount : '',
      currency:            fields.currency || 'IDR',
      payment_status:      fields.payment_status || '',
      is_paid:             fields.is_paid === true,
      provider_tx_id:      fields.provider_tx_id || '',
      received_at:         fields.received_at || new Date().toISOString(),
      signature_verified:  fields.signature_verified === true
    };
  }

  return {
    buildCompositeKey: buildCompositeKey,
    buildEventDigest:  buildEventDigest,
    validate:          validate,
    create:            create
  };

})();
