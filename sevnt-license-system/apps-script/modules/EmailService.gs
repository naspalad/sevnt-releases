/**
 * EmailService — Email outbox management for the SEVNT License System.
 *
 * Design:
 * - Emails are NEVER sent synchronously during a request (risk of quota issues
 *   or timeouts affecting the main flow).
 * - All emails are written to the EMAIL_OUTBOX sheet first (queueEmail).
 * - processEmailQueue() is called by a time-based trigger (every 5 minutes).
 * - Up to 3 delivery attempts; failures are logged without affecting license data.
 *
 * Templates:
 *   LICENSE_DELIVERY  — New license key after payment
 *   SUPPORT_RECOVERY  — Recovered/reissued license key
 *   ACTIVATION_CONFIRM — Device activation confirmation
 *
 * QUOTA NOTE: GmailApp/MailApp is limited to ~100 emails/day for consumer
 * Google accounts and 1500/day for Workspace. Monitor EMAIL_OUTBOX failures.
 */

const EmailService = (function() {

  const TEMPLATES = {
    LICENSE_DELIVERY:    'LICENSE_DELIVERY',
    SUPPORT_RECOVERY:    'SUPPORT_RECOVERY',
    ACTIVATION_CONFIRM:  'ACTIVATION_CONFIRM'
  };

  const MAX_ATTEMPTS = 3;

  // ─── Queue ────────────────────────────────────────────────────────────────

  /**
   * Queue a license delivery email (after successful payment).
   *
   * @param {string} licenseId
   * @param {string} recipientEmail
   * @param {string} licenseKey     - Plaintext key (sent to customer via email)
   */
  function queueLicenseDelivery(licenseId, recipientEmail, licenseKey) {
    _queue(licenseId, recipientEmail, TEMPLATES.LICENSE_DELIVERY, {
      license_key: licenseKey
    });
  }

  /**
   * Queue a support recovery email.
   *
   * @param {string} licenseId
   * @param {string} recipientEmail
   * @param {string} newLicenseKey  - New plaintext key (or null if no reissue)
   */
  function queueSupportRecovery(licenseId, recipientEmail, newLicenseKey) {
    _queue(licenseId, recipientEmail, TEMPLATES.SUPPORT_RECOVERY, {
      license_key: newLicenseKey || null
    });
  }

  function _queue(licenseId, recipient, template, payload) {
    const emailId = SecurityService.generateId();
    DatabaseService.createEmailJob({
      email_id:   emailId,
      license_id: licenseId,
      recipient:  recipient,
      template:   template,
      status:     EMAIL_STATUS.PENDING,
      attempts:   0,
      created_at: new Date().toISOString(),
      sent_at:    '',
      last_error: '',
      payload:    JSON.stringify(payload)
    });

    AuditService.log(AuditService.EVENT_TYPE.EMAIL_QUEUED,
      licenseId, null, 'system', 'SUCCESS',
      { template: template, email_id: emailId });

    return emailId;
  }

  // ─── Processor (called by trigger) ───────────────────────────────────────

  /**
   * Process the email outbox. Called by a time-based Apps Script trigger.
   * Run from: Edit > Triggers > processEmailQueue — every 5 minutes.
   */
  function processEmailQueue() {
    const pending = DatabaseService.findPendingEmails();
    if (pending.length === 0) return;

    pending.forEach(function(job) {
      const attempts = Number(job.attempts) || 0;
      try {
        _sendEmail(job);
        DatabaseService.updateEmailJob(job._rowIndex, {
          status:   EMAIL_STATUS.SENT,
          sent_at:  new Date().toISOString(),
          attempts: attempts + 1
        });
        AuditService.log(AuditService.EVENT_TYPE.EMAIL_SENT,
          job.license_id, null, 'system', 'SUCCESS',
          { template: job.template, email_id: job.email_id });

      } catch (err) {
        const newAttempts = attempts + 1;
        const isFinal = newAttempts >= MAX_ATTEMPTS;
        DatabaseService.updateEmailJob(job._rowIndex, {
          status:     isFinal ? EMAIL_STATUS.FAILED : EMAIL_STATUS.PENDING,
          attempts:   newAttempts,
          last_error: err.message
        });
        AuditService.log(AuditService.EVENT_TYPE.EMAIL_FAILED,
          job.license_id, null, 'system', 'FAILURE',
          { template: job.template, error: err.message, attempt: newAttempts });
      }
    });
  }

  function _sendEmail(job) {
    const payload = job.payload ? JSON.parse(job.payload) : {};
    const content = _renderTemplate(job.template, payload, job.recipient);

    MailApp.sendEmail({
      to:       job.recipient,
      subject:  content.subject,
      htmlBody: content.html,
      body:     content.text
    });
  }

  // ─── Templates ────────────────────────────────────────────────────────────

  function _renderTemplate(template, payload, recipient) {
    switch (template) {
      case TEMPLATES.LICENSE_DELIVERY:
        return _templateLicenseDelivery(payload.license_key, recipient, payload.customer_name || '');
      case TEMPLATES.SUPPORT_RECOVERY:
        return _templateSupportRecovery(payload.license_key);
      case TEMPLATES.ACTIVATION_CONFIRM:
        return _templateActivationConfirm();
      default:
        throw new Error('Unknown email template: ' + template);
    }
  }

  function _templateLicenseDelivery(licenseKey, recipientEmail, customerName) {
    const subject = 'Your SOCL Visuals Studio License Key';
    const displayName = customerName || recipientEmail || 'there';
    const appVersion = 'v2.3.1';

    const text = [
      'You\'re in, ' + displayName + '.',
      'Welcome to the studio. Time to make some viral hooks.',
      '',
      'LICENSE KEY:',
      licenseKey,
      '',
      'ACTIVATION EMAIL:',
      recipientEmail || '',
      'Use this exact email when activating in the app.',
      '',
      'QUICK START:',
      '01  Download for your OS',
      '02  Mac: right-click app > Open. Win: More info > Run anyway',
      '03  Paste your email + license key',
      '04  Hit Activate. Start cooking.',
      '',
      '1 license · 1 device · lifetime updates',
      'Need to switch devices? Email soclvisuals@gmail.com',
      '',
      '© SOCL Visuals Studio · Make hooks, not noise.'
    ].join('\n');

    const html = '<!DOCTYPE html><html><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<style>' +
        'body{margin:0;padding:0;background:#0d0d0d;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}' +
        '.wrap{max-width:400px;margin:0 auto;padding:32px 16px;}' +
        '.logo-box{display:inline-block;background:#1a1a1a;border:1px solid #2a2a2a;border-radius:10px;padding:12px 18px;text-align:center;margin-bottom:16px;}' +
        '.logo-text{color:#c8ff00;font-size:22px;font-weight:800;letter-spacing:1px;line-height:1.1;}' +
        '.brand-row{margin-bottom:28px;}' +
        '.brand-name{color:#888;font-size:11px;letter-spacing:3px;text-transform:uppercase;}' +
        '.version-badge{display:inline-block;background:#c8ff00;color:#0d0d0d;font-size:10px;font-weight:700;padding:2px 8px;border-radius:20px;margin-left:8px;letter-spacing:1px;}' +
        'h1{color:#fff;font-size:26px;font-weight:700;margin:0 0 8px;}' +
        '.subtitle{color:#666;font-size:14px;margin:0 0 32px;}' +
        '.subtitle a{color:#c8ff00;text-decoration:none;}' +
        '.card{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:12px;padding:20px;margin-bottom:12px;}' +
        '.card-label{color:#555;font-size:10px;letter-spacing:2px;text-transform:uppercase;margin-bottom:8px;}' +
        '.license-key{color:#c8ff00;font-family:"Courier New",monospace;font-size:16px;font-weight:700;letter-spacing:1px;word-break:break-all;}' +
        '.email-val{color:#fff;font-size:14px;}' +
        '.email-hint{color:#555;font-size:11px;margin-top:4px;}' +
        '.section-label{color:#555;font-size:10px;letter-spacing:2px;text-transform:uppercase;margin:28px 0 12px;}' +
        '.dl-btn{display:block;background:#c8ff00;color:#0d0d0d;text-decoration:none;border-radius:10px;padding:14px 20px;font-size:14px;font-weight:700;text-align:center;margin-bottom:4px;}' +
        '.dl-sub{color:#555;font-size:11px;text-align:center;margin-bottom:28px;}' +
        '.steps{margin:0;padding:0;list-style:none;}' +
        '.step{display:flex;gap:14px;align-items:flex-start;margin-bottom:12px;}' +
        '.step-num{color:#c8ff00;font-size:11px;font-weight:700;min-width:20px;padding-top:1px;}' +
        '.step-text{color:#aaa;font-size:13px;line-height:1.4;}' +
        '.step-text strong{color:#fff;}' +
        '.tg-card{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:12px;padding:20px;margin-top:28px;}' +
        '.tg-label{color:#555;font-size:10px;letter-spacing:2px;text-transform:uppercase;margin-bottom:4px;}' +
        '.tg-title{color:#fff;font-size:16px;font-weight:700;margin-bottom:2px;}' +
        '.tg-sub{color:#555;font-size:11px;}' +
        '.footer{color:#333;font-size:11px;text-align:center;margin-top:32px;line-height:1.8;}' +
        '.footer a{color:#555;text-decoration:none;}' +
      '</style></head><body>' +
      '<div class="wrap">' +
        '<div style="text-align:center;">' +
          '<div class="logo-box"><div class="logo-text">SCL<br>VSL</div></div>' +
        '</div>' +
        '<div class="brand-row" style="text-align:center;">' +
          '<span class="brand-name">SOCL Visuals Studio</span>' +
          '<span class="version-badge">' + appVersion + ' · Latest</span>' +
        '</div>' +
        '<h1>You\'re in, ' + displayName + '. ✦</h1>' +
        '<p class="subtitle">Welcome to the studio. Time to make some <a href="#">viral hooks.</a></p>' +
        '<div class="card">' +
          '<div class="card-label">License Key</div>' +
          '<div class="license-key">' + licenseKey + '</div>' +
        '</div>' +
        '<div class="card">' +
          '<div class="card-label">Activation Email</div>' +
          '<div class="email-val">' + (recipientEmail || '') + '</div>' +
          '<div class="email-hint">Use this exact email when activating in the app.</div>' +
        '</div>' +
        '<div class="section-label">↓ Get the App</div>' +
        '<a class="dl-btn" href="https://soclvisuals.com/download">↓ Download SOCL Visuals Studio →</a>' +
        '<div class="dl-sub">Mac (Apple Silicon / Intel) · Windows (Installer / Portable) · always the latest version</div>' +
        '<div class="section-label">Quick Start</div>' +
        '<ul class="steps">' +
          '<li class="step"><span class="step-num">01</span><span class="step-text">Download for your OS</span></li>' +
          '<li class="step"><span class="step-num">02</span><span class="step-text">Mac: right-click app > <strong>Open</strong>. Win: <strong>More info → Run anyway</strong></span></li>' +
          '<li class="step"><span class="step-num">03</span><span class="step-text">Paste your email + license key</span></li>' +
          '<li class="step"><span class="step-num">04</span><span class="step-text">Hit <strong>Activate.</strong> Start cooking. 🔥</span></li>' +
        '</ul>' +
        '<div class="tg-card">' +
          '<div class="tg-label">Join the Studio</div>' +
          '<div class="tg-title">Community on Telegram →</div>' +
          '<div class="tg-sub">Updates · tips · showcase · troubleshoot</div>' +
        '</div>' +
        '<div class="footer">' +
          '1 license · 1 device · lifetime updates<br>' +
          'Need to switch devices? Email <a href="mailto:soclvisuals@gmail.com">soclvisuals@gmail.com</a><br><br>' +
          '© SOCL Visuals Studio · Make hooks, not noise.' +
        '</div>' +
      '</div>' +
      '</body></html>';

    return { subject: subject, text: text, html: html };
  }

  function _templateSupportRecovery(newLicenseKey) {
    const subject = 'SEVNT Studio — Account Recovery';
    const keySection = newLicenseKey
      ? 'New License Key:\n' + newLicenseKey + '\n\nAll previous device activations have been cleared.'
      : 'Your account has been recovered. All previous device activations have been cleared.\n' +
        'You can now activate your devices again using your original license key.';

    const text = [
      'Your SEVNT Studio account has been recovered by our support team.',
      '',
      keySection,
      '',
      'If you did not request this recovery, contact support@sevntstudio.com immediately.',
      '',
      'SEVNT Studio Support'
    ].join('\n');

    const html = '<p>Your SEVNT Studio account has been recovered by our support team.</p>' +
      (newLicenseKey
        ? '<p><strong>New License Key:</strong></p>' +
          '<p style="font-family:monospace;font-size:1.2em;background:#f5f5f5;padding:12px;border-radius:4px;">' + newLicenseKey + '</p>' +
          '<p>All previous device activations have been cleared.</p>'
        : '<p>All previous device activations have been cleared. You can re-activate with your original key.</p>') +
      '<p><small>If you did not request this, contact <a href="mailto:support@sevntstudio.com">support@sevntstudio.com</a> immediately.</small></p>';

    return { subject: subject, text: text, html: html };
  }

  function _templateActivationConfirm() {
    const subject = 'SEVNT Studio — Device Activated';
    const text = 'Your device has been successfully activated for SEVNT Studio.\n\nSEVNT Studio Team';
    const html = '<p>Your device has been successfully activated for SEVNT Studio.</p>';
    return { subject: subject, text: text, html: html };
  }

  return {
    TEMPLATES:            TEMPLATES,
    queueLicenseDelivery: queueLicenseDelivery,
    queueSupportRecovery: queueSupportRecovery,
    processEmailQueue:    processEmailQueue,
    _renderTemplatePublic: _renderTemplate
  };

})();
