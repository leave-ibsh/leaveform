(function () {
  'use strict';

  const GRACE_DAYS = 3;
  const PAPER_INSTRUCTION = 'Online make-up is closed. A parent must sign the form, print it, obtain the homeroom teacher signature, and submit it to the Discipline Office.';
  const TYPE_LABELS = {
    personal: 'Personal',
    health: 'Sick',
    mentalHealth: 'Mental Health',
    funeral: 'Funeral',
    official: 'Official',
  };

  function text(value) {
    return String(value == null ? '' : value).trim();
  }

  function lower(value) {
    return text(value).toLowerCase();
  }

  function leaveType(record) {
    return text(record && (record.leaveReason || record.leaveType));
  }

  function typeLabel(record) {
    const key = leaveType(record);
    return TYPE_LABELS[key] || key || 'Leave';
  }

  function isWalkin(record) {
    if (!record) return false;
    const source = lower(record.source || record.leaveSource);
    return Boolean(record.isWalkin)
      || source === 'walkin'
      || source === 'walk-in'
      || lower(record.submittedBy).includes('walk-in')
      || record.submittedByRole === 'staff';
  }

  function isOfficial(record) {
    return leaveType(record) === 'official';
  }

  function isActive(record) {
    if (!record || record.archived) return false;
    return !['rejected', 'archived'].includes(lower(record.status || 'pending'));
  }

  function workflow() {
    const settings = window.AppDB && typeof window.AppDB.getSettings === 'function'
      ? window.AppDB.getSettings()
      : {};
    return Array.isArray(settings.approvalWorkflow) ? settings.approvalWorkflow : [];
  }

  function isParentStage(stage) {
    if (!stage) return false;
    if (stage.approverType === 'parent') return true;
    return /parent|guardian/i.test(text(stage.id) + ' ' + text(stage.name));
  }

  function parentStageIds() {
    return new Set(workflow().filter(isParentStage).map(stage => text(stage.id)));
  }

  function parentApprovalEntry(record) {
    const ids = parentStageIds();
    const history = Array.isArray(record && record.stageHistory) ? record.stageHistory : [];
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const entry = history[index] || {};
      if (entry.action !== 'approved') continue;
      if (ids.has(text(entry.stageId))) return entry;
      if (/parent|guardian/i.test(text(entry.stageId) + ' ' + text(entry.stageName))) return entry;
    }
    return null;
  }

  function hasParentApproval(record) {
    if (!isActive(record)) return false;
    if (lower(record.status) === 'approved') return true;
    return Boolean(parentApprovalEntry(record));
  }

  function isAtParentStage(record) {
    if (!record || lower(record.status || 'pending') !== 'pending') return false;
    if (parentApprovalEntry(record)) return false;
    const stages = workflow();
    if (!stages.length) return false;
    const index = Math.max(0, Math.min(Number(record.currentStageIndex) || 0, stages.length - 1));
    return isParentStage(stages[index]);
  }

  function dateTimeRange(record) {
    const fromDate = text(record && (record.fromDate || text(record.startTime).slice(0, 10)));
    const toDate = text(record && (record.toDate || text(record.endTime).slice(0, 10))) || fromDate;
    const fromTime = text(record && (record.fromTime || text(record.startTime).slice(11, 16))) || '08:10';
    const toTime = text(record && (record.toTime || text(record.endTime).slice(11, 16))) || '16:10';
    return { start: fromDate + 'T' + fromTime, end: toDate + 'T' + toTime };
  }

  function overlaps(left, right) {
    const a = dateTimeRange(left);
    const b = dateTimeRange(right);
    return Boolean(a.start && a.end && b.start && b.end && a.start <= b.end && a.end >= b.start);
  }

  function sameCase(left, right) {
    if (!left || !right) return false;
    return text(left.studentNo) === text(right.studentNo)
      && leaveType(left) === leaveType(right)
      && overlaps(left, right);
  }

  function relatedForm(walkin, allLeaves) {
    if (!walkin) return null;
    const leaves = Array.isArray(allLeaves) ? allLeaves : [];
    const linkedId = text(walkin.reconciledByLeaveId);
    if (linkedId) {
      const linked = leaves.find(item => text(item && item.id) === linkedId && !item.archived);
      if (linked && !isWalkin(linked)) return linked;
    }
    const explicit = leaves.find(item => item
      && !item.archived
      && !isWalkin(item)
      && text(item.reconciliationSourceId) === text(walkin.id));
    if (explicit) return explicit;
    const candidates = leaves
      .filter(item => item && !item.archived && !isWalkin(item) && sameCase(walkin, item))
      .sort((a, b) => {
        const statusScore = value => lower(value && value.status) === 'approved' ? 3 : lower(value && value.status) === 'pending' ? 2 : 1;
        return statusScore(b) - statusScore(a) || text(b.submittedAt).localeCompare(text(a.submittedAt));
      });
    return candidates[0] || null;
  }

  function dateAtMidnight(value) {
    const date = new Date(text(value).slice(0, 10) + 'T00:00:00');
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function daysSinceEnd(walkin, now) {
    const end = dateAtMidnight(walkin && (walkin.toDate || walkin.fromDate));
    const current = dateAtMidnight(now || new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' }));
    if (!end || !current) return 0;
    return Math.max(0, Math.floor((current - end) / 86400000));
  }

  function deadlineDate(walkin) {
    const end = dateAtMidnight(walkin && (walkin.toDate || walkin.fromDate));
    if (!end) return '';
    end.setDate(end.getDate() + GRACE_DAYS);
    return end.getFullYear() + '-' + String(end.getMonth() + 1).padStart(2, '0') + '-' + String(end.getDate()).padStart(2, '0');
  }

  function completed(walkin, form) {
    const sourceStatus = lower(walkin && walkin.status);
    const formStatus = lower(form && form.status);
    return Boolean(walkin && (walkin.returnConfirmed
      || walkin.reconciliationStatus === 'reconciled'
      || ['approved', 'reconciled'].includes(sourceStatus)))
      || ['approved', 'reconciled'].includes(formStatus);
  }

  function stateFor(walkin, form, now) {
    if (completed(walkin, form)) return 'completed';
    if (isOfficial(walkin)) return 'official_paper';
    if (form && form.makeupMode === 'paper') return 'paper_required';
    if (daysSinceEnd(walkin, now) > GRACE_DAYS && !(form && hasParentApproval(form))) return 'paper_required';
    if (!form || lower(form.status) === 'rejected') return 'online_available';
    if (hasParentApproval(form)) return 'school_review';
    return 'awaiting_parent';
  }

  function stateMeta(state) {
    const map = {
      online_available: { label: 'Online available', tone: 'action', group: 'action' },
      awaiting_parent: { label: 'Awaiting parent sign', tone: 'warning', group: 'action' },
      school_review: { label: 'School review', tone: 'review', group: 'review' },
      paper_required: { label: 'Paper required', tone: 'danger', group: 'action' },
      official_paper: { label: 'Official paper form', tone: 'danger', group: 'action' },
      completed: { label: 'Completed', tone: 'complete', group: 'completed' },
    };
    return map[state] || map.online_available;
  }

  function casesForStudent(student, allLeaves, now) {
    const studentNo = text(student && (student.studentNo || student.studentId));
    const leaves = (Array.isArray(allLeaves) ? allLeaves : []).filter(item => !studentNo || text(item && item.studentNo) === studentNo);
    return leaves
      .filter(item => item && isWalkin(item) && !item.archived)
      .map(walkin => {
        const form = relatedForm(walkin, leaves);
        const state = stateFor(walkin, form, now);
        return {
          id: text(walkin.id),
          walkin,
          form,
          state,
          meta: stateMeta(state),
          deadline: deadlineDate(walkin),
          daysOpen: daysSinceEnd(walkin, now),
          typeLabel: typeLabel(walkin),
          parentSigned: hasParentApproval(form || walkin),
        };
      })
      .sort((a, b) => {
        const score = item => item.meta.group === 'action' ? 3 : item.meta.group === 'review' ? 2 : 1;
        return score(b) - score(a)
          || text(b.walkin.toDate || b.walkin.fromDate).localeCompare(text(a.walkin.toDate || a.walkin.fromDate));
      });
  }

  function caseById(caseId, student, allLeaves, now) {
    return casesForStudent(student, allLeaves, now).find(item => item.id === text(caseId)) || null;
  }

  function parentEmails(student) {
    const values = [student && student.parentEmailList, student && student.fatherEmail, student && student.motherEmail, student && student.parentEmail];
    return [...new Set(values.flatMap(value => Array.isArray(value) ? value : text(value).split(/[\s,;，；/]+/)).map(lower).filter(Boolean))];
  }

  function studentEmails(student) {
    const values = [student && student.studentEmailList, student && student.email];
    return [...new Set(values.flatMap(value => Array.isArray(value) ? value : [value]).map(lower).filter(Boolean))];
  }

  function initialStageIndex(record) {
    const stages = workflow();
    if (!window.AppDB || typeof window.AppDB.nextApplicableStageIndex !== 'function') return 0;
    const index = window.AppDB.nextApplicableStageIndex(stages, record, 0);
    return index === -1 ? 0 : index;
  }

  function parentSignedCreationState(record, actorEmail, comment, signature) {
    const stages = workflow();
    let index = initialStageIndex(record);
    const history = [];
    while (index < stages.length && isParentStage(stages[index])) {
      history.push({
        stageId: text(stages[index].id),
        stageName: text(stages[index].name),
        action: 'approved',
        by: lower(actorEmail) || 'parent',
        at: new Date().toISOString(),
        comment: text(comment),
        signature,
      });
      const next = window.AppDB.nextApplicableStageIndex(stages, record, index + 1);
      if (next === -1) break;
      index = next;
    }
    return { currentStageIndex: index, stageHistory: history };
  }

  function buildFormRecord(options) {
    const input = options || {};
    const walkin = input.walkin || {};
    const student = input.student || {};
    const role = input.role === 'parent' ? 'parent' : 'student';
    const reason = text(input.reason);
    const base = {
      className: text(student.className || walkin.className),
      studentClass: text(student.className || walkin.className),
      studentNo: text(student.studentNo || walkin.studentNo),
      seatNo: text(student.seatNo || walkin.seatNo),
      chineseName: text(student.chineseName || walkin.chineseName),
      englishName: text(student.englishName || walkin.englishName),
      studentEmails: studentEmails(student),
      parentEmails: parentEmails(student),
      leaveType: leaveType(walkin),
      leaveReason: leaveType(walkin),
      fromDate: text(walkin.fromDate),
      toDate: text(walkin.toDate || walkin.fromDate),
      fromTime: text(walkin.fromTime) || '08:10',
      toTime: text(walkin.toTime) || '16:10',
      fullDay: Boolean(walkin.fullDay),
      periods: Number(walkin.periods || walkin.totalPeriods) || 0,
      totalPeriods: Number(walkin.periods || walkin.totalPeriods) || 0,
      reason,
      parentNote: reason,
      status: 'pending',
      currentStageIndex: 0,
      stageHistory: [],
      reconciliationSourceId: text(walkin.id),
      reconciliationStatus: 'submitted',
      makeupMode: input.paperMode ? 'paper' : 'online',
      submittedBy: lower(input.actorEmail),
      submittedByRole: role,
      submittedAt: new Date().toISOString(),
    };
    if (input.paperMode) base.paperRequiredAt = new Date().toISOString();
    base.currentStageIndex = initialStageIndex(base);
    if (role === 'parent' && input.signature && text(input.comment)) {
      const signed = parentSignedCreationState(base, input.actorEmail, input.comment, input.signature);
      base.currentStageIndex = signed.currentStageIndex;
      base.stageHistory = signed.stageHistory;
      base.parentSignedAt = new Date().toISOString();
    }
    return base;
  }

  async function markSourceSubmitting(walkinId, formId) {
    return window.AppDB.updateLeave(walkinId, {
      reconciliationStatus: 'submitting',
      reconciledByLeaveId: text(formId),
    });
  }

  async function signParent(recordId, options) {
    const input = options || {};
    const stages = workflow();
    let updated = null;
    updated = await window.AppDB.updateLeaveTransaction(recordId, current => {
      if (parentApprovalEntry(current)) return {};
      const index = Math.max(0, Math.min(Number(current.currentStageIndex) || 0, Math.max(0, stages.length - 1)));
      const stage = stages[index];
      if (!isParentStage(stage)) throw new Error('This form is no longer awaiting parent sign.');
      const history = Array.isArray(current.stageHistory) ? current.stageHistory.slice() : [];
      history.push({
        stageId: text(stage.id),
        stageName: text(stage.name),
        action: 'approved',
        by: lower(input.actorEmail) || 'parent',
        at: new Date().toISOString(),
        comment: text(input.comment),
        signature: input.signature,
      });
      const next = window.AppDB.nextApplicableStageIndex(stages, current, index + 1);
      const payload = {
        stageHistory: history,
        currentStageIndex: next === -1 ? index : next,
        status: 'pending',
      };
      if (!isWalkin(current)) {
        payload.parentSignedAt = new Date().toISOString();
        if (input.paperMode) {
          payload.makeupMode = 'paper';
          payload.paperRequiredAt = new Date().toISOString();
        }
      }
      return payload;
    });
    return updated;
  }

  function printUrl(record, signState) {
    const id = encodeURIComponent(text(record && record.id));
    const state = encodeURIComponent(text(signState));
    return id ? 'makeup-form.html?id=' + id + (state ? '&parentSigned=' + state : '') : '#';
  }

  window.MakeupService = {
    GRACE_DAYS,
    PAPER_INSTRUCTION,
    leaveType,
    typeLabel,
    isWalkin,
    isOfficial,
    isParentStage,
    isAtParentStage,
    parentApprovalEntry,
    hasParentApproval,
    relatedForm,
    daysSinceEnd,
    deadlineDate,
    stateFor,
    stateMeta,
    casesForStudent,
    caseById,
    buildFormRecord,
    markSourceSubmitting,
    signParent,
    printUrl,
  };
})();
