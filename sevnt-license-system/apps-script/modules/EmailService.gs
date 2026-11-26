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
 * Sending: Brevo Transactional API (api.brevo.com/v3/smtp/email)
 * Required Script Properties: BREVO_API_KEY, BREVO_SENDER_EMAIL
 */

const EmailService = (function() {

  const TEMPLATES = {
    LICENSE_DELIVERY:    'LICENSE_DELIVERY',
    SUPPORT_RECOVERY:    'SUPPORT_RECOVERY',
    ACTIVATION_CONFIRM:  'ACTIVATION_CONFIRM'
  };

  const MAX_ATTEMPTS = 3;

  // ─── Queue ────────────────────────────────────────────────────────────────

  function queueLicenseDelivery(licenseId, recipientEmail, licenseKey, customerName) {
    _queue(licenseId, recipientEmail, TEMPLATES.LICENSE_DELIVERY, {
      license_key:   licenseKey,
      customer_name: customerName || ''
    });
  }

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

    const apiKey = PropertiesService.getScriptProperties().getProperty('BREVO_API_KEY');
    if (!apiKey) throw new Error('BREVO_API_KEY not set in Script Properties');

    const senderEmail = PropertiesService.getScriptProperties().getProperty('BREVO_SENDER_EMAIL');
    if (!senderEmail) throw new Error('BREVO_SENDER_EMAIL not set in Script Properties');

    const response = UrlFetchApp.fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'api-key': apiKey,
        'accept':  'application/json'
      },
      payload: JSON.stringify({
        sender:      { name: 'SEVNT Studio', email: senderEmail },
        to:          [{ email: job.recipient }],
        subject:     content.subject,
        htmlContent: content.html,
        textContent: content.text
      }),
      muteHttpExceptions: true
    });

    const status = response.getResponseCode();
    if (status < 200 || status >= 300) {
      throw new Error('Brevo send failed (' + status + '): ' + response.getContentText());
    }
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

  function _escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function _templateLicenseDelivery(licenseKey, recipientEmail, customerName) {
    const subject = 'Akses SEVNT Studio Kamu Siap Digunakan — Kunci Lisensi';
    const rawName = (customerName || '').trim();
    const greetingName = rawName || (recipientEmail ? recipientEmail.split('@')[0] : 'Kreator');

    const safeGreetingName = _escapeHtml(greetingName);
    const safeLicenseKey   = _escapeHtml(licenseKey || 'SEVNT-XXXX-XXXX-XXXX');
    const safeEmail        = _escapeHtml(recipientEmail || '');

    const uniqueRef  = Utilities.getUuid().slice(0, 8).toUpperCase();
    const telegramUrl = 'https://t.me/+fXwm7qL6sb1jZjhl';
    const downloadUrl = 'https://sevnt-downloader.vercel.app/';

    const headerBg = [
      'background-color: #050505;',
      'background-image: linear-gradient(180deg, rgba(255, 255, 255, 0) 64%, rgba(255, 255, 255, 0.5) 82%, rgba(255, 255, 255, 0.92) 93%, #ffffff 100%),',
      'radial-gradient(125% 105% at 88% 82%, rgba(255, 255, 255, 0.98) 0%, rgba(255, 232, 237, 0.92) 15%, rgba(240, 68, 99, 0.65) 34%, rgba(153, 17, 42, 0.35) 54%, rgba(5, 5, 5, 0) 76%),',
      'linear-gradient(166deg, #040404 0%, #070709 36%, #2a060e 53%, #880e24 64%, #e11d48 72%, #ffa8b8 79%, #ffffff 87%, #ffffff 100%);'
    ].join(' ');

    const text = [
      'Akses SEVNT Studio Siap Digunakan.',
      '',
      'Halo ' + greetingName + ',',
      'Terima kasih telah memilih SEVNT Studio. Lisensi kamu berhasil dibuat dan sekarang siap digunakan.',
      '',
      'KUNCI LISENSI KAMU:',
      licenseKey || '',
      'Simpan kunci lisensi ini dengan aman.',
      '',
      'EMAIL AKTIVASI:',
      recipientEmail || '',
      'Gunakan alamat email yang sama saat mengaktifkan aplikasi.',
      '',
      'UNDUH APLIKASI:',
      downloadUrl,
      '',
      'PANDUAN MEMULAI:',
      '01  Unduh SEVNT Studio.',
      '02  Pasang, lalu buka aplikasinya.',
      '03  Masukkan email aktivasi dan kunci lisensi kamu.',
      '04  Klik Aktifkan untuk mulai menggunakan SEVNT Studio.',
      '',
      'KOMUNITAS DI TELEGRAM:',
      telegramUrl,
      '',
      'INFORMASI LISENSI:',
      '1 Lisensi · 1 Perangkat · Pembaruan Selamanya',
      'Butuh bantuan? Hubungi support@sevntstudio.com',
      '',
      '© 2026 SEVNT Studio. Hak cipta dilindungi. Ref: ' + uniqueRef
    ].join('\n');

    const html = [
      '<!DOCTYPE html>',
      '<html lang="id">',
      '<head>',
      '<meta charset="UTF-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
      '<title>SEVNT Studio — Pengiriman Lisensi</title>',
      '</head>',
      '<body style="margin:0;padding:0;background-color:#e9e9ec;font-family:\'Plus Jakarta Sans\',Arial,Helvetica,sans-serif;color:#18181b;">',
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#e9e9ec;width:100%;">',
      '  <tr>',
      '    <td align="center" style="padding:32px 12px;">',
      '      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background-color:#ffffff;border:1px solid #dedee2;border-radius:18px;overflow:hidden;">',

      // HEADER
      '        <tr>',
      '          <td align="center" style="padding:34px 28px 92px;text-align:center;' + headerBg + '">',
      '            <img src="https://i.ibb.co.com/Jj1byCz1/SEVNT-STUDIO.png" width="118" height="118" alt="Logo SEVNT Studio" style="display:block;width:118px;height:118px;object-fit:contain;margin:0 auto 6px;border:0;">',
      '            <div style="font-size:18px;font-weight:800;letter-spacing:0.8px;color:#ffffff;text-shadow:0 2px 10px rgba(0,0,0,0.85);">SEVNT <span style="color:#ff4d6d;">STUDIO</span></div>',
      '            <div style="margin-top:4px;color:#f4f4f5;font-size:9px;font-weight:600;letter-spacing:2.5px;text-shadow:0 1px 8px rgba(0,0,0,0.85);">PENGIRIMAN LISENSI STUDIO</div>',
      '          </td>',
      '        </tr>',

      // INTRO
      '        <tr>',
      '          <td align="center" style="padding:14px 32px 20px;background-color:#ffffff;text-align:center;">',
      '            <h1 style="margin:0 0 13px;font-size:26px;font-weight:800;line-height:1.25;letter-spacing:-0.5px;color:#18181b;">Akses SEVNT Studio Siap Digunakan.</h1>',
      '            <p style="margin:0;color:#5b5b63;font-size:14px;line-height:1.8;">Halo ' + safeGreetingName + ',<br><br>Terima kasih telah memilih SEVNT Studio. Lisensi kamu berhasil dibuat dan sekarang siap digunakan.</p>',
      '          </td>',
      '        </tr>',

      // KUNCI LISENSI
      '        <tr>',
      '          <td style="padding:12px 32px 0;background-color:#ffffff;">',
      '            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#fafafa;border:1px solid #e7e7e9;border-radius:14px;">',
      '              <tr>',
      '                <td align="center" style="padding:21px 22px;text-align:center;">',
      '                  <div style="color:#777780;font-size:10px;font-weight:700;letter-spacing:2px;">KUNCI LISENSI KAMU</div>',
      '                  <div style="margin-top:12px;color:#dc2626;font-size:19px;font-weight:700;line-height:1.5;word-break:break-all;">' + safeLicenseKey + '</div>',
      '                  <div style="margin-top:8px;color:#85858d;font-size:11px;line-height:1.6;">Simpan kunci lisensi ini dengan aman.</div>',
      '                </td>',
      '              </tr>',
      '            </table>',
      '          </td>',
      '        </tr>',

      // EMAIL AKTIVASI
      '        <tr>',
      '          <td style="padding:12px 32px 0;background-color:#ffffff;">',
      '            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#fafafa;border:1px solid #e7e7e9;border-radius:14px;">',
      '              <tr>',
      '                <td align="center" style="padding:21px 22px;text-align:center;">',
      '                  <div style="color:#777780;font-size:10px;font-weight:700;letter-spacing:2px;">EMAIL AKTIVASI</div>',
      '                  <div style="margin-top:10px;font-size:14px;font-weight:700;color:#18181b;word-break:break-all;">' + safeEmail + '</div>',
      '                  <div style="margin-top:8px;color:#85858d;font-size:11px;line-height:1.6;">Gunakan alamat email yang sama saat mengaktifkan aplikasi.</div>',
      '                </td>',
      '              </tr>',
      '            </table>',
      '          </td>',
      '        </tr>',

      // UNDUH APLIKASI
      '        <tr>',
      '          <td align="center" style="padding:27px 32px 0;background-color:#ffffff;text-align:center;">',
      '            <div style="color:#777780;font-size:10px;font-weight:700;letter-spacing:2px;">UNDUH APLIKASI</div>',
      '            <p style="margin:10px 0 15px;color:#62626a;font-size:13px;line-height:1.7;">Unduh SEVNT Studio dan pasang aplikasinya di komputer kamu.</p>',
      '            <a href="' + downloadUrl + '" target="_blank" style="display:inline-block;padding:14px 22px;background-color:#dc2626;color:#ffffff;text-decoration:none;font-size:13px;font-weight:700;border-radius:10px;">Unduh SEVNT Studio</a>',
      '          </td>',
      '        </tr>',

      // PANDUAN MEMULAI
      '        <tr>',
      '          <td style="padding:27px 32px 0;background-color:#ffffff;">',
      '            <div style="color:#777780;font-size:10px;font-weight:700;letter-spacing:2px;margin-bottom:14px;">PANDUAN MEMULAI</div>',
      '            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">',
      '              <tr><td width="34" valign="top" style="padding:8px 0;color:#dc2626;font-size:13px;font-weight:700;">01</td><td valign="top" style="padding:8px 0;color:#5d5d65;font-size:13px;line-height:1.55;">Unduh SEVNT Studio.</td></tr>',
      '              <tr><td width="34" valign="top" style="padding:8px 0;color:#dc2626;font-size:13px;font-weight:700;">02</td><td valign="top" style="padding:8px 0;color:#5d5d65;font-size:13px;line-height:1.55;">Pasang, lalu buka aplikasinya.</td></tr>',
      '              <tr><td width="34" valign="top" style="padding:8px 0;color:#dc2626;font-size:13px;font-weight:700;">03</td><td valign="top" style="padding:8px 0;color:#5d5d65;font-size:13px;line-height:1.55;">Masukkan email aktivasi dan kunci lisensi kamu.</td></tr>',
      '              <tr><td width="34" valign="top" style="padding:8px 0;color:#dc2626;font-size:13px;font-weight:700;">04</td><td valign="top" style="padding:8px 0;color:#5d5d65;font-size:13px;line-height:1.55;">Klik Aktifkan untuk mulai menggunakan SEVNT Studio.</td></tr>',
      '            </table>',
      '          </td>',
      '        </tr>',

      // KOMUNITAS TELEGRAM
      '        <tr>',
      '          <td style="padding:26px 32px 28px;background-color:#ffffff;">',
      '            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#fafafa;border:1px solid #e7e7e9;border-radius:14px;">',
      '              <tr>',
      '                <td align="center" style="padding:22px;text-align:center;">',
      '                  <div style="font-size:10px;font-weight:800;letter-spacing:2px;color:#dc2626;">JOIN THE AREA</div>',
      '                  <div style="margin-top:14px;">',
      '                    <a href="' + telegramUrl + '" target="_blank" style="display:inline-block;padding:13px 26px;border-radius:13px;text-decoration:none;font-size:14px;font-weight:700;color:#ffffff;background-color:#18181b;background-image:linear-gradient(125deg,#18181b 0%,#7f1d1d 55%,#dc2626 100%);border:1px solid #dc2626;">Komunitas Di Telegram &nbsp;&#10148;</a>',
      '                  </div>',
      '                  <div style="margin-top:12px;font-size:11px;line-height:1.6;color:#777780;">Update · Tips · Troubleshoot · Dan lain-lain</div>',
      '                </td>',
      '              </tr>',
      '            </table>',
      '          </td>',
      '        </tr>',

      // FOOTER
      '        <tr>',
      '          <td align="center" style="padding:23px 32px 26px;background-color:#fafafa;border-top:1px solid #eeeeee;text-align:center;">',
      '            <strong style="font-size:12px;color:#18181b;">INFORMASI LISENSI</strong>',
      '            <p style="margin:7px 0 0;color:#777780;font-size:12px;">1 Lisensi · 1 Perangkat · Pembaruan Selamanya</p>',
      '            <p style="margin:7px 0 0;color:#777780;font-size:12px;">Butuh bantuan? Hubungi <a href="mailto:support@sevntstudio.com" style="color:#dc2626;text-decoration:none;">support@sevntstudio.com</a></p>',
      '            <p style="margin:14px 0 0;">',
      '              <a href="https://www.instagram.com/sevnt.hq?lqvp=MTN5aGRubmU4YTNsdg==" target="_blank" style="color:#dc2626;text-decoration:none;font-size:12px;font-weight:700;">',
      '                <img src="https://i.ibb.co.com/BVTJ7d29/logo-instagram.jpg" width="18" height="18" alt="Instagram" style="width:18px;height:18px;object-fit:contain;vertical-align:middle;margin-right:5px;border:0;">',
      '                <span style="vertical-align:middle;">@sevnt.hq</span>',
      '              </a>',
      '            </p>',
      '            <p style="margin:19px 0 0;color:#a1a1aa;font-size:11px;">© 2026 SEVNT Studio. Hak cipta dilindungi. · ID #' + uniqueRef + '</p>',
      '          </td>',
      '        </tr>',

      '      </table>',
      '    </td>',
      '  </tr>',
      '</table>',
      '</body>',
      '</html>'
    ].join('\n');

    return { subject: subject, text: text, html: html };
  }

  function _templateSupportRecovery(newLicenseKey) {
    const subject = 'SEVNT Studio — Pemulihan Akun';
    const keySection = newLicenseKey
      ? 'Kunci Lisensi Baru:\n' + newLicenseKey + '\n\nSemua aktivasi perangkat sebelumnya telah dihapus.'
      : 'Akun kamu telah dipulihkan. Semua aktivasi perangkat sebelumnya telah dihapus.\n' +
        'Kamu dapat mengaktifkan perangkat lagi menggunakan kunci lisensi asli kamu.';

    const text = [
      'Akun SEVNT Studio kamu telah dipulihkan oleh tim support kami.',
      '',
      keySection,
      '',
      'Jika kamu tidak meminta pemulihan ini, hubungi support@sevntstudio.com segera.',
      '',
      'SEVNT Studio Support'
    ].join('\n');

    const html = '<p>Akun SEVNT Studio kamu telah dipulihkan oleh tim support kami.</p>' +
      (newLicenseKey
        ? '<p><strong>Kunci Lisensi Baru:</strong></p>' +
          '<p style="font-family:monospace;font-size:1.2em;background:#f5f5f5;padding:12px;border-radius:4px;">' + _escapeHtml(newLicenseKey) + '</p>' +
          '<p>Semua aktivasi perangkat sebelumnya telah dihapus.</p>'
        : '<p>Semua aktivasi perangkat sebelumnya telah dihapus. Kamu dapat mengaktifkan ulang dengan kunci asli kamu.</p>') +
      '<p><small>Jika kamu tidak meminta ini, hubungi <a href="mailto:support@sevntstudio.com">support@sevntstudio.com</a> segera.</small></p>';

    return { subject: subject, text: text, html: html };
  }

  function _templateActivationConfirm() {
    const subject = 'SEVNT Studio — Perangkat Diaktifkan';
    const text = 'Perangkat kamu berhasil diaktifkan untuk SEVNT Studio.\n\nTim SEVNT Studio';
    const html = '<p>Perangkat kamu berhasil diaktifkan untuk SEVNT Studio.</p>';
    return { subject: subject, text: text, html: html };
  }

  return {
    TEMPLATES:             TEMPLATES,
    queueLicenseDelivery:  queueLicenseDelivery,
    queueSupportRecovery:  queueSupportRecovery,
    processEmailQueue:     processEmailQueue,
    _renderTemplatePublic: _renderTemplate
  };

})();
