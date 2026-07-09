(function () {
  'use strict';
  function settings() {
    return (window.AppDB && typeof window.AppDB.getSettings === 'function')
      ? window.AppDB.getSettings()
      : {};
  }
  function cleanEmail(email) {
    return String(email || '').trim().toLowerCase();
  }
  function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail(email));
  }
  function splitEmailList(value) {
    const values = Array.isArray(value) ? value : [value];
    return values.flatMap(item => String(item || '').split(/[,\uFF0C;\uFF1B, \/\s]+/));
  }
  function uniqueEmails(values) {
    return [...new Set(splitEmailList(values).map(cleanEmail).filter(isValidEmail))];
  }
  function currentStudentForLeave(leave) {
    if (!leave || !window.AppDB || typeof window.AppDB.getStudentByNo !== 'function') return null;
    try {
      return window.AppDB.getStudentByNo(leave.studentNo || leave.studentId || '');
    } catch (error) {
      console.warn('[Notifications] Unable to read current student contact data:', error);
      return null;
    }
  }
  function parentEmailsForLeave(leave) {
    const student = currentStudentForLeave(leave);
    const directParents = student ? uniqueEmails([student.fatherEmail, student.motherEmail]) : [];
    const current = directParents.length ? directParents : (student ? uniqueEmails([student.parentEmail]) : []);
    return current.length ? current : uniqueEmails(leave && leave.parentEmails || []);
  }
  function studentEmailsForLeave(leave) {
    const student = currentStudentForLeave(leave);
    const current = student ? uniqueEmails([student.email]) : [];
    return current.length ? current : uniqueEmails(leave && leave.studentEmails || []);
  }
  function normalizeClassName(value) {
    const text = String(value || '')
      .trim()
      .toUpperCase()
      .replace(/Ａ/g, 'A')
      .replace(/Ｂ/g, 'B')
      .replace(/GRADE/g, '')
      .replace(/[.\s_\-\/()]+/g, '');
    const match = text.match(/^G?([1-9]|1[0-2])([AB])$/);
    return match ? (String(Number(match[1])) + match[2]) : text;
  }
  function appRootUrl() {
    const configured = String(settings().notificationAppUrl || '').trim();
    if (configured) return configured.replace(/\/+$/, '');
    const path = window.location.pathname.replace(/\/[^/]*$/, '');
    return (window.location.origin + path).replace(/\/+$/, '');
  }
  // Allow-listed webhook hosts. Any URL not on this list (or non-HTTPS) is
  // rejected to avoid leaking parent/student PII to attacker-controlled
  // endpoints if an admin account is compromised. To add a domain, append
  // it here AND re-deploy hosting.
  const WEBHOOK_HOST_ALLOWLIST = [
    'script.google.com',
    'script.googleusercontent.com',
    'cloudfunctions.net',
    'run.app',
  ];
  function isWebhookUrlAllowed(raw) {
    const url = String(raw || '').trim();
    if (!url) return false;
    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      return false;
    }
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    return WEBHOOK_HOST_ALLOWLIST.some(allowed =>
      host === allowed || host.endsWith('.' + allowed)
    );
  }
  function webhookUrl() {
    const raw = String(settings().notificationWebhookUrl || window.__EMAIL_WEBHOOK_URL__ || '').trim();
    if (!isWebhookUrlAllowed(raw)) {
      if (raw) {
        console.warn('[Notifications] Webhook URL rejected (must be HTTPS and on allow-list):', raw);
      }
      return '';
    }
    return raw;
  }
  function isParentStage(stage) {
    if (!stage) return false;
    if (stage.approverType === 'parent') return true;
    const text = String(stage.id || '') + ' ' + String(stage.name || '');
    return /parent|guardian/i.test(text);
  }
  function currentStage(leave) {
    const wf = settings().approvalWorkflow || [];
    if (!wf.length || !leave) return null;
    const idx = Math.max(0, Math.min(leave.currentStageIndex || 0, wf.length - 1));
    return wf[idx] || null;
  }
  function routedEmailsForRole(role, leave) {
    const routes = settings().notificationRecipients || {};
    if (role === 'homeroom') {
      const targetClass = normalizeClassName(leave && (leave.className || leave.studentClass));
      const byClass = routes.homeroom || {};
      return uniqueEmails([byClass[targetClass]]);
    }
    return uniqueEmails([routes[role]]);
  }
  function staffEmailsForRole(role, leave) {
    const routed = routedEmailsForRole(role, leave);
    if (routed.length) return routed;
    const users = settings().staffUsers || [];
    const targetClass = normalizeClassName(leave && (leave.className || leave.studentClass));
    return uniqueEmails(users
      .filter(user => {
        const roles = (Array.isArray(user.roles) ? user.roles : [])
          .map(item => String(item || '').trim().toLowerCase());
        if (!roles.includes(role)) return false;
        if (role === 'homeroom') {
          return normalizeClassName(user.homeroomClass || user.className || '') === targetClass;
        }
        return true;
      })
      .map(user => user.email));
  }
  function emailsForAction(action, leave) {
    if (!leave) return [];
    if (action === 'notify_parents') return parentEmailsForLeave(leave);
    if (action === 'notify_homeroom') return staffEmailsForRole('homeroom', leave);
    if (action === 'notify_discipline') return staffEmailsForRole('discipline', leave);
    if (action === 'notify_dean') return staffEmailsForRole('dean', leave);
    if (action === 'notify_result') return uniqueEmails([].concat(studentEmailsForLeave(leave), parentEmailsForLeave(leave)));
    if (action === 'remind_reconciliation') return studentEmailsForLeave(leave);
    return [];
  }
  function diagnose(action, leave, explicitEmails) {
    const url = webhookUrl();
    const stage = currentStage(leave);
    const emails = uniqueEmails(explicitEmails || emailsForAction(action, leave));
    return {
      hasUrl: Boolean(url),
      urlHost: url ? new URL(url).hostname : '',
      action: action || '',
      inferredAction: actionForCurrentStage(leave),
      emailCount: emails.length,
      emails,
      className: normalizeClassName(leave && (leave.className || leave.studentClass)),
      currentStage: stage ? {
        id: stage.id || '',
        name: stage.name || '',
        approverType: stage.approverType || '',
        staffRole: stage.staffRole || '',
      } : null,
    };
  }
  function actionForCurrentStage(leave) {
    if (!leave) return '';
    const status = String(leave.status || 'pending');
    if (status === 'approved' || status === 'rejected') return 'notify_result';
    if (status !== 'pending') return '';
    const stage = currentStage(leave);
    if (isParentStage(stage)) return 'notify_parents';
    const role = String(stage && stage.staffRole || '').toLowerCase();
    if (role === 'homeroom') return 'notify_homeroom';
    if (role === 'discipline') return 'notify_discipline';
    if (role === 'dean') return 'notify_dean';
    return '';
  }
  function compactLeaveData(leave) {
    leave = leave || {};
    return {
      id: String(leave.id || ''),
      status: String(leave.status || ''),
      className: String(leave.className || leave.studentClass || ''),
      studentNo: String(leave.studentNo || leave.studentId || ''),
      seatNo: String(leave.seatNo || ''),
      englishName: String(leave.englishName || ''),
      chineseName: String(leave.chineseName || ''),
      leaveReason: String(leave.leaveReason || leave.leaveType || ''),
      leaveType: String(leave.leaveType || leave.leaveReason || ''),
      fromDate: String(leave.fromDate || ''),
      toDate: String(leave.toDate || leave.fromDate || ''),
      fromTime: String(leave.fromTime || ''),
      toTime: String(leave.toTime || ''),
      periods: String(leave.periods || leave.totalPeriods || ''),
      totalPeriods: String(leave.totalPeriods || leave.periods || ''),
      parentNote: String(leave.parentNote || leave.reason || ''),
      reason: String(leave.reason || leave.parentNote || ''),
    };
  }
  function send(action, leave, explicitEmails) {
    const url = webhookUrl();
    const emails = uniqueEmails(explicitEmails || emailsForAction(action, leave));
    if (!url || !action || !emails.length || !leave) {
      const skipped = {
        skipped: true,
        reason: !url ? 'missing_webhook_url' : !action ? 'missing_action' : !leave ? 'missing_leave' : 'missing_recipients',
        hasUrl: Boolean(url),
        action,
        emailCount: emails.length,
        hasLeave: Boolean(leave),
        emails,
      };
      console.warn('[Notifications] Skipped email notification:', skipped, diagnose(action, leave, explicitEmails));
      return Promise.resolve(skipped);
    }
    const payload = {
      action,
      emails,
      leaveData: compactLeaveData(leave),
      appUrl: appRootUrl(),
    };
    console.info('[Notifications] Sending email notification:', { action, emails, appUrl: payload.appUrl });
    const body = JSON.stringify(payload);
    return fetch(url, {
      method: 'POST',
      mode: 'no-cors',
      keepalive: true,
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body,
    })
      .then(() => {
        console.info('[Notifications] Email notification request sent:', { action, emails });
        return { ok: true, method: 'fetch-no-cors', action, emails };
      })
      .catch(error => {
        console.warn('[Notifications] fetch failed; trying sendBeacon fallback:', error);
        if (navigator.sendBeacon) {
          try {
            const blob = new Blob([body], { type: 'text/plain;charset=utf-8' });
            const queued = navigator.sendBeacon(url, blob);
            if (queued) return { ok: true, method: 'sendBeacon-fallback', action, emails };
          } catch (beaconError) {
            console.warn('[Notifications] sendBeacon fallback failed:', beaconError);
          }
        }
        return { ok: false, action, emails, error };
      });
  }
  function notifyNext(leave) {
    const action = actionForCurrentStage(leave);
    return action ? send(action, leave) : Promise.resolve({ skipped: true });
  }
  function notifyResult(leave) {
    return send('notify_result', leave);
  }
  function remindReconciliation(leave) {
    return send('remind_reconciliation', leave);
  }
  window.IBSHNotifications = {
    send,
    notifyNext,
    notifyResult,
    remindReconciliation,
    emailsForAction,
    actionForCurrentStage,
    diagnose,
    isValidEmail,
    compactLeaveData,
  };
})();
