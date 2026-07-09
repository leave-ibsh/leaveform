/**
 * IBSH Leave System email bridge for Google Apps Script.
 *
 * Deploy as:
 *   Apps Script > Deploy > New deployment > Web app
 *   Execute as: Me
 *   Who has access: Anyone
 *
 * Put the deployed /exec URL into admin.html > Settings > Notifications.
 */
function jsonResponse(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
function htmlEscape(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function leaveDetailsHtml(leave) {
  return ''
    + '<br><br>'
    + '<b>Student</b> '
    + htmlEscape(leave.className) + ' '
    + htmlEscape(leave.englishName) + ' '
    + htmlEscape(leave.chineseName || '') + ' ('
    + htmlEscape(leave.studentNo) + ')<br>'
    + '<b>Leave Type:</b> ' + htmlEscape(leave.leaveReason || leave.leaveType) + '<br>'
    + '<b>Duration</b> '
    + htmlEscape(leave.fromDate) + ' ' + htmlEscape(leave.fromTime)
    + ' ~ ' + htmlEscape(leave.toDate) + ' ' + htmlEscape(leave.toTime)
    + ' (' + htmlEscape(leave.periods || leave.totalPeriods || '') + ' periods)<br>'
    + '<b>Reason</b> ' + htmlEscape(leave.parentNote || leave.reason || '');
}
function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(email));
}
function uniqueValidEmails(emails) {
  var seen = {};
  var valid = [];
  var invalid = [];
  (emails || []).forEach(function (email) {
    var normalized = normalizeEmail(email);
    if (!normalized) return;
    if (!isValidEmail(normalized)) {
      invalid.push(normalized);
      return;
    }
    if (!seen[normalized]) {
      seen[normalized] = true;
      valid.push(normalized);
    }
  });
  return { valid: valid, invalid: invalid };
}
function emailTemplate(action, leave, appUrl) {
  var details = leaveDetailsHtml(leave || {});
  var baseUrl = String(appUrl || '').replace(/\/+$/, '');
  var subject = '';
  var htmlBody = '';
  switch (action) {
    case 'notify_parents':
      subject = '[IBSH Leave] Parent Signature Needed: ' + (leave.englishName || '');
      htmlBody = 'Dear Parents:<br><br>'
        + 'Your child has submitted a leave request that requires your electronic approval.<br>'
        + 'Your child has submitted a leave request that requires your approval.'
        + details + '<br><br>'
        + '👉 <a href="' + htmlEscape(baseUrl + '/index.html') + '">Click here to sign</a>';
      break;
    case 'notify_homeroom':
      subject = '[IBSH Leave] Homeroom Teacher Approval Needed: ' + (leave.englishName || '');
      htmlBody = 'Dear Homeroom Teacher:<br><br>'
        + 'A parent has approved this leave request. Please review it in the admin console.<br>'
        + 'The parent has approved this leave request. Please review it in the admin console.'
        + details + '<br><br>'
        + '👉 <a href="' + htmlEscape(baseUrl + '/admin.html') + '">Go to Admin Console</a>';
      break;
    case 'notify_discipline':
      subject = '[IBSH Leave] Discipline Office Approval Needed: ' + (leave.englishName || '');
      htmlBody = 'Dear Disciplinarian:<br><br>'
        + 'The homeroom teacher has approved this leave request. Please review it.<br>'
        + 'The homeroom teacher has approved this leave. Please review.'
        + details + '<br><br>'
        + '👉 <a href="' + htmlEscape(baseUrl + '/admin.html') + '">Go to Admin Console</a>';
      break;
    case 'notify_dean':
      subject = '[IBSH Leave] Dean Approval Needed: ' + (leave.englishName || '');
      htmlBody = 'Dear Dean<br><br>'
        + 'This leave request is for 3 or more days and requires your final approval.<br>'
        + 'This leave request is for 3 or more days and requires your final approval.'
        + details + '<br><br>'
        + '👉 <a href="' + htmlEscape(baseUrl + '/admin.html') + '">Go to Admin Console</a>';
      break;
    case 'notify_result':
      var approved = leave.status === 'approved';
      var statusText = approved ? 'Approved' : 'Rejected';
      var color = approved ? '#10b981' : '#ef4444';
      subject = '[IBSH Leave] Leave Request ' + statusText + ': ' + (leave.englishName || '');
      htmlBody = 'Dear Student & Parents<br><br>'
        + 'Your leave request status has been updated.<br>'
        + 'Your leave request status has been updated.<br><br>'
        + '<b>Status</b> <span style="color:' + color + '; font-weight:bold;">' + statusText + '</span>'
        + details;
      break;
    case 'remind_reconciliation':
      subject = '[IBSH Leave] Reconciliation Reminder: ' + (leave.englishName || '');
      htmlBody = 'Dear Student<br><br>'
        + 'You have a walk-in leave record that still needs an online make-up form.<br>'
        + 'You have a pending walk-in leave that requires an online form submission.'
        + details + '<br><br>'
        + 'Please log in and submit the matching leave form as soon as possible.<br>'
        + 'Please log in to the system and submit your official leave form as soon as possible.<br><br>'
        + '👉 <a href="' + htmlEscape(baseUrl + '/index.html') + '">Click here to submit</a>';
      break;
  }
  return { subject: subject, htmlBody: htmlBody };
}
function doPost(e) {
  try {
    var payload = JSON.parse(e.postData.contents || '{}');
    var action = payload.action || '';
    var leave = payload.leaveData || {};
    var emails = Array.isArray(payload.emails) ? payload.emails : [];
    var checkedEmails = uniqueValidEmails(emails);
    var toEmails = checkedEmails.valid.join(',');
    console.log('[IBSH Mail] action=' + action + ', valid=' + checkedEmails.valid.join(',') + ', invalid=' + checkedEmails.invalid.join(','));
    if (!toEmails) {
      return jsonResponse({
        status: 'error',
        message: 'No valid emails provided',
        invalidEmails: checkedEmails.invalid,
      });
    }
    var template = emailTemplate(action, leave, payload.appUrl || '');
    if (!template.subject || !template.htmlBody) {
      return jsonResponse({ status: 'error', message: 'Unsupported action: ' + action });
    }
    GmailApp.sendEmail(toEmails, template.subject, '', {
      htmlBody: template.htmlBody,
      name: 'IBSH Leave System',
    });
    console.log('[IBSH Mail] sent subject=' + template.subject);
    return jsonResponse({
      status: checkedEmails.invalid.length ? 'partial_success' : 'success',
      sentTo: checkedEmails.valid,
      invalidEmails: checkedEmails.invalid,
    });
  } catch (err) {
    return jsonResponse({ status: 'error', message: String(err) });
  }
}
