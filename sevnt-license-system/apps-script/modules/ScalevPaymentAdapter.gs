/**
 * ScalevPaymentAdapter — Scalev payment webhook adapter.
 *
 * DOCUMENTATION SOURCE:
 *   https://dev.scalev.com/docs/webhooks-overview
 *   https://dev.scalev.com/docs/enabling-webhooks
 *   https://dev.scalev.com/docs/verifying-a-webhook-request
 *   https://dev.scalev.com/docs/webhook-events
 *   Verified: 2026-11-09
 *
 * SIGNATURE MECHANISM (VERIFIED from docs):
 *   Header:    X-Scalev-Hmac-Sha256
 *   Algorithm: HMAC-SHA256(raw_body_bytes, signing_secret) → Base64 (NOT hex)
 *   Key:       Signing Secret (from Settings > Developers > Webhooks in Scalev dashboard)
 *              IMPORTANT: This is NOT the API key (sk_... / rk_...)
 *              Docs explicitly state: "API keys are not webhook secrets"
 *
 * VERIFIED PAYLOAD STRUCTURE:
 *   {
 *     "event":     "<event_name>",    // e.g. "payment.received"
 *     "unique_id": "event_...",       // idempotency key
 *     "timestamp": "<ISO8601>",
 *     "data":      { ...order... }
 *   }
 *
 * VERIFIED RELEVANT EVENTS:
 *   payment.received  — payment status became "paid" or "settled" → USE THIS for license issuance
 *   payment.failed    — payment status became "conflict"
 *   order.created     — new order created (payment may not be confirmed yet)
 *   business.test_event — Scalev sends this when webhook URL is first saved (MUST return 2xx)
 *
 * VERIFIED DATA FIELDS (from order payload example):
 *   order_id               — e.g. "250130JQHFZG" (Scalev's order ID)
 *   payment_status         — "paid" | "unpaid" | "conflict" | "settled"
 *   destination_address.email — buyer email
 *   gross_revenue          — total order value
 *   unique_id (top-level)  — event ID for idempotency
 *
 * ⚠️ GAS HEADER LIMITATION — SIGNATURE BLOCKED:
 *   Apps Script doPost(e) does NOT expose arbitrary HTTP headers.
 *   X-Scalev-Hmac-Sha256 IS DOCUMENTED but CANNOT BE READ in GAS.
 *   See: https://issuetracker.google.com/issues/36763610
 *
 *   Additionally, Scalev requires the EXACT RAW BODY BYTES for HMAC computation.
 *   e.postData.contents in GAS may differ from raw bytes if encoding conversion occurs.
 *   This is a secondary concern once the header issue is resolved.
 *
 * DIAGNOSTIC MODE:
 *   When DiagnosticService.isDiagnosticMode() = true, parse() returns structured data
 *   that is captured by DiagnosticService, not processed as payment.
 *   Special case: business.test_event MUST return 2xx even in diagnostic mode.
 *
 * STATUS: SIGNATURE_BLOCKED (header unreadable in GAS)
 *         FIELD NAMES: VERIFIED from documentation
 *         FULLY_BLOCKED: false (documentation is now accessible and complete)
 */

const ScalevPaymentAdapter = (function() {

  const PROVIDER = 'scalev';

  // SIGNATURE_BLOCKED: X-Scalev-Hmac-Sha256 not readable in GAS
  const SIGNATURE_BLOCKED = true;

  // No longer fully blocked — docs are accessible, fields are verified
  const FULLY_BLOCKED = false;

  // VERIFIED field paths from Scalev webhook payload
  const FIELDS = {
    EVENT:          'event',                          // VERIFIED
    UNIQUE_ID:      'unique_id',                      // VERIFIED — event-level idempotency key
    TIMESTAMP:      'timestamp',                      // VERIFIED
    DATA:           'data',                           // VERIFIED — container for order data
    ORDER_ID:       'data.order_id',                  // VERIFIED — e.g. "250130JQHFZG"
    PAYMENT_STATUS: 'data.payment_status',            // VERIFIED — "paid"|"unpaid"|"conflict"|"settled"
    EMAIL:          'data.destination_address.email', // VERIFIED
    GROSS_REVENUE:  'data.gross_revenue',             // VERIFIED — string e.g. "149724.00"
    CURRENCY:       'IDR'                             // VERIFIED — Scalev is IDR-only platform
  };

  // VERIFIED: Scalev events that indicate successful payment
  const PAID_STATUSES_FOR_DATA = ['paid', 'settled'];

  // VERIFIED: event types
  const EVENTS = {
    PAYMENT_RECEIVED:  'payment.received',    // VERIFIED — primary event for license issuance
    PAYMENT_FAILED:    'payment.failed',      // VERIFIED
    ORDER_CREATED:     'order.created',       // VERIFIED
    ORDER_UPDATED:     'order.updated',       // VERIFIED
    STATUS_CHANGED:    'order.payment_status_changed', // VERIFIED
    TEST_EVENT:        'business.test_event'  // VERIFIED — sent on webhook URL save, MUST return 2xx
  };

  // VERIFIED: signature header
  const SIGNATURE_HEADER = 'X-Scalev-Hmac-Sha256'; // VERIFIED — but NOT readable in GAS

  /**
   * Parse and normalize a Scalev webhook body.
   *
   * Returns a NormalizedTransaction for payment events.
   * Returns a special test_event response for business.test_event.
   * Returns null for unrecognized or non-payment events.
   *
   * @param {Object} body - Parsed JSON body
   * @param {Object} e    - Apps Script event (headers NOT readable)
   * @returns {NormalizedTransaction|{_test_event: true}|null}
   */
  function parse(body, e) {
    if (!body) return null;

    const event    = body[FIELDS.EVENT];
    const uniqueId = body[FIELDS.UNIQUE_ID];
    const data     = body[FIELDS.DATA] || {};

    // Handle Scalev's test event — must return 2xx when webhook URL is first saved
    if (event === EVENTS.TEST_EVENT) {
      Logger.log('ScalevPaymentAdapter.parse: Received business.test_event — returning ACK');
      return { _is_test_event: true, unique_id: uniqueId };
    }

    if (!event) {
      Logger.log('ScalevPaymentAdapter.parse: missing event field');
      return null;
    }

    // Extract fields from verified payload structure
    const orderId      = data.order_id || '';
    const payStatus    = data.payment_status || '';
    const email        = (data.destination_address && data.destination_address.email) || '';
    const grossRevenue = data.gross_revenue || '';

    if (!orderId) {
      Logger.log('ScalevPaymentAdapter.parse: missing data.order_id. event=' + event);
      return null;
    }

    // For payment.received/failed, verify data exists
    const isPaymentEvent = (event === EVENTS.PAYMENT_RECEIVED || event === EVENTS.PAYMENT_FAILED);
    const isPaid = isPaymentEvent && PAID_STATUSES_FOR_DATA.indexOf(payStatus) !== -1;

    // Signature: BLOCKED — X-Scalev-Hmac-Sha256 not readable in GAS
    const sigVerified = false;

    return PaymentNormalizer.create({
      provider:           PROVIDER,
      external_order_id:  orderId,
      customer_email:     email,
      amount:             grossRevenue,
      currency:           FIELDS.CURRENCY,
      payment_status:     payStatus,
      is_paid:            isPaid,
      provider_tx_id:     uniqueId || '',  // use event unique_id as tx ref
      received_at:        body[FIELDS.TIMESTAMP] || new Date().toISOString(),
      signature_verified: sigVerified
    });
  }

  /**
   * Compute HMAC-SHA256 signature for verification blueprint.
   * NOT usable in production GAS path (header unreadable, raw bytes may differ).
   * Provided as reference implementation once middleware is in place.
   *
   * Algorithm (VERIFIED): HMAC-SHA256(raw_body_bytes, signing_secret) → Base64
   *
   * NOTE: GAS Utilities.computeHmacSha256Signature returns byte array, not Base64.
   * Conversion: Utilities.base64Encode(byteArray)
   *
   * @param {string} rawBody       - Raw request body string (e.postData.contents)
   * @param {string} signingSecret - From Script Property SCALEV_WEBHOOK_SIGNING_SECRET
   * @returns {string} Base64-encoded HMAC-SHA256
   */
  function computeExpectedSignature(rawBody, signingSecret) {
    const bytes = Utilities.computeHmacSha256Signature(rawBody, signingSecret);
    return Utilities.base64Encode(bytes);
  }

  /**
   * Mock Scalev webhook body for testing.
   * Uses VERIFIED payload structure from documentation.
   *
   * @param {string} email
   * @param {string} event - e.g. 'payment.received' | 'business.test_event'
   * @returns {Object}
   */
  function mockWebhookBody(email, event) {
    const orderId = 'SCVTEST' + SecurityService.generateId().slice(0, 8).toUpperCase();
    return {
      event:     event || EVENTS.PAYMENT_RECEIVED,
      unique_id: 'event_' + SecurityService.generateId().replace(/-/g, ''),
      timestamp: new Date().toISOString(),
      data: {
        order_id:       orderId,
        payment_status: 'paid',
        gross_revenue:  '299000.00',
        destination_address: {
          email: email || 'test@example.com',
          name:  '[MOCK]'
        }
      }
    };
  }

  /**
   * Mock Scalev test event (business.test_event).
   * Used to test the webhook registration flow.
   *
   * @returns {Object}
   */
  function mockTestEvent() {
    return {
      event:     EVENTS.TEST_EVENT,
      unique_id: 'event_' + SecurityService.generateId().replace(/-/g, ''),
      timestamp: new Date().toISOString(),
      data:      {}
    };
  }

  return {
    PROVIDER:          PROVIDER,
    SIGNATURE_BLOCKED: SIGNATURE_BLOCKED,
    FULLY_BLOCKED:     FULLY_BLOCKED,
    FIELDS:            FIELDS,
    EVENTS:            EVENTS,
    SIGNATURE_HEADER:  SIGNATURE_HEADER,
    parse:             parse,
    computeExpectedSignature: computeExpectedSignature,
    mockWebhookBody:   mockWebhookBody,
    mockTestEvent:     mockTestEvent
  };

})();
