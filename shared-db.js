/**
 * shared-db.js
 * Firestore-backed data layer for IBSH School Leave Management System
 * International Bilingual School at Hsinchu Science Park
 *
 * Exposed as window.AppDB
 */
(function () {
  'use strict';
  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------
  const LEGACY_STORAGE_KEYS = [
    'ibsh_students',
    'ibsh_leaves',
    'ibsh_tardies',
    'ibsh_holidays',
    'ibsh_settings',
  ];
  const COLLECTIONS = {
    students: 'students',
    publicStudents: 'publicStudents',
    leaves: 'leaves',
    tardies: 'tardies',
    holidays: 'holidays',
    settings: 'settings',
    publicSettings: 'publicSettings',
    signatures: 'signatures',
  };
  const SETTINGS_DOC_ID = 'app';
  const BATCH_LIMIT = 400;
  const GRADE_ADVANCE_MAX_STUDENTS = 600;
  const GRADE_ADVANCE_CHUNK_SIZE = 300;
  const PERIODS = [
    { id: 1,   label: 'Period 1', start: '08:10', end: '09:00' },
    { id: 2,   label: 'Period 2', start: '09:10', end: '10:00' },
    { id: 3,   label: 'Period 3', start: '10:10', end: '11:00' },
    { id: 4,   label: 'Period 4', start: '11:10', end: '12:00' },
    { id: 'L', label: 'Lunch',    start: '12:00', end: '13:00' },
    { id: 5,   label: 'Period 5', start: '13:10', end: '14:00' },
    { id: 6,   label: 'Period 6', start: '14:10', end: '15:00' },
    { id: 7,   label: 'Period 7', start: '15:20', end: '16:10' },
  ];
  const ACADEMIC_PERIODS = PERIODS.filter(period => period.id !== 'L');
  const DEFAULT_APPROVAL_WORKFLOW = [
    { id: 'parent',     name: 'Parent approval',       approverType: 'parent' },
    { id: 'homeroom',   name: 'Homeroom Teacher', approverType: 'staff', staffRole: 'homeroom' },
    { id: 'discipline', name: 'Discipline Office', approverType: 'staff', staffRole: 'discipline' },
    { id: 'dean',       name: "Dean",           approverType: 'staff', staffRole: 'dean',
      condition: { type: 'minDays', value: 3 } },
  ];
  const DEFAULT_TARDY_REASON_SUGGESTIONS = [
    'Traffic congestion',
    'Overslept',
    'Missed the bus',
    'Family transportation delay',
    'Medical appointment',
    'Personal emergency',
  ];
  const DEFAULT_SETTINGS = {
    currentSchoolYear: '',
    gradeYearOffset: 0,
    approvalWorkflow: DEFAULT_APPROVAL_WORKFLOW.slice(),
    staffUsers: [],
    notificationWebhookUrl: '',
    notificationAppUrl: '',
    tardyReasonSuggestions: DEFAULT_TARDY_REASON_SUGGESTIONS.slice(),
    examPeriods: [],
  };
  const DEFAULT_LEAVE_TIMES = {
    fromTime: '08:10',
    toTime: '16:10',
  };
  const CLASS_NAME_COLLATOR = new Intl.Collator('zh-Hant-TW', {
    numeric: true,
    sensitivity: 'base',
  });
  // ---------------------------------------------------------------------------
  // Internal state
  // ---------------------------------------------------------------------------
  let _app = null;
  let _db = null;
  let _initPromise = null;
  let _portalInitPromise = null;
  let _portalInitKey = '';
  let _adminInitPromise = null;
  let _adminInitKey = '';
  let _tardyInitPromise = null;
  let _writeQueue = Promise.resolve();
  let _students = [];
  let _leaves = [];
  let _tardies = [];
  let _holidays = [];
  let _settings = { ...DEFAULT_SETTINGS };
  let _status = {
    mode: 'memory',
    error: null,
  };
  // ---------------------------------------------------------------------------
  // Helpers – persistence
  // ---------------------------------------------------------------------------
  function _clearLegacyStorage() {
    try {
      LEGACY_STORAGE_KEYS.forEach(key => localStorage.removeItem(key));
    } catch (error) {
      console.warn('[AppDB] Failed to clear legacy localStorage keys', error);
    }
  }
  function _resetState() {
    _students = [];
    _leaves = [];
    _tardies = [];
    _holidays = [];
    _settings = { ...DEFAULT_SETTINGS };
  }
  function _emitStatus() {
    window.dispatchEvent(new CustomEvent('app-db-status', {
      detail: status(),
    }));
  }
  function _setStatus(mode, error, extra) {
    _status = {
      mode: mode || 'memory',
      error: error || null,
      ...(extra || {}),
    };
    _emitStatus();
  }
  function _getFirebaseNamespace() {
    return window.firebase || null;
  }
  function _getFirebaseConfig() {
    return window.__FIREBASE_CONFIG__ || null;
  }
  function _stripUndefined(value) {
    if (Array.isArray(value)) {
      return value.map(item => _stripUndefined(item));
    }
    if (!value || typeof value !== 'object') {
      return value;
    }
    const result = {};
    Object.keys(value).forEach(key => {
      if (value[key] !== undefined) {
        result[key] = _stripUndefined(value[key]);
      }
    });
    return result;
  }
  function _queueWrite(task) {
    const run = _writeQueue.catch(() => undefined).then(async () => {
      if (!_db) return null;
      return task();
    });
    _writeQueue = run.catch(error => {
      console.error('[AppDB] Firebase write failed:', error);
      _setStatus(_db ? 'firebase' : 'memory', error && error.message ? error.message : 'Firebase write failed.');
    });
    return run;
  }
  async function _commitChunkedSet(collectionName, records) {
    if (!_db || !records || records.length === 0) return;
    for (let start = 0; start < records.length; start += BATCH_LIMIT) {
      const batch = _db.batch();
      records.slice(start, start + BATCH_LIMIT).forEach(record => {
        const clean = _stripUndefined(record);
        const docId = clean.id || _generateId();
        delete clean.id;
        batch.set(_db.collection(collectionName).doc(docId), clean, { merge: true });
      });
      await batch.commit();
    }
  }
  async function _commitChunkedDelete(collectionName, ids) {
    if (!_db || !ids || ids.length === 0) return;
    for (let start = 0; start < ids.length; start += BATCH_LIMIT) {
      const batch = _db.batch();
      ids.slice(start, start + BATCH_LIMIT).forEach(id => {
        batch.delete(_db.collection(collectionName).doc(id));
      });
      await batch.commit();
    }
  }
  async function _loadCollection(collectionName, normalizer) {
    if (!_db) return [];
    const snapshot = await _db.collection(collectionName).get();
    return snapshot.docs
      .map(doc => normalizer({ id: doc.id, ...doc.data() }))
      .filter(Boolean);
  }
  async function _loadCollectionByExactValues(collectionName, field, values, normalizer) {
    if (!_db) return [];
    const uniqueValues = [...new Set((values || [])
      .map(value => String(value || '').trim())
      .filter(Boolean))];
    if (!uniqueValues.length) return [];
    const byId = new Map();
    for (const value of uniqueValues) {
      const snapshot = await _db.collection(collectionName).where(field, '==', value).get();
      snapshot.docs.forEach(doc => {
        const normalized = normalizer({ id: doc.id, ...doc.data() });
        if (normalized) byId.set(normalized.id, normalized);
      });
    }
    return [...byId.values()];
  }
  async function _loadSettingsDoc() {
    if (!_db) {
      _settings = { ...DEFAULT_SETTINGS };
      return;
    }
    const settingsSnap = await _db.collection(COLLECTIONS.settings).doc(SETTINGS_DOC_ID).get();
    _settings = {
      ...DEFAULT_SETTINGS,
      ...(settingsSnap.exists ? settingsSnap.data() : {}),
    };
  }
  function _publicSettingsFrom(settings) {
    const source = {
      ...DEFAULT_SETTINGS,
      ...(settings || {}),
    };
    return {
      currentSchoolYear: String(source.currentSchoolYear || ''),
      gradeYearOffset: Number(source.gradeYearOffset || 0) || 0,
      approvalWorkflow: _normalizeWorkflow(source.approvalWorkflow),
      tardyReasonSuggestions: (Array.isArray(source.tardyReasonSuggestions)
        ? source.tardyReasonSuggestions
        : DEFAULT_TARDY_REASON_SUGGESTIONS)
        .map(reason => String(reason || '').trim())
        .filter(Boolean),
      examPeriods: _normalizeExamPeriods(source.examPeriods),
      notificationWebhookUrl: String(source.notificationWebhookUrl || ''),
      notificationAppUrl: String(source.notificationAppUrl || ''),
      notificationRecipients: _notificationRecipientsFromStaffUsers(source.staffUsers),
    };
  }
  async function _loadPublicSettingsDoc() {
    if (!_db) {
      _settings = { ...DEFAULT_SETTINGS };
      return;
    }
    const settingsSnap = await _db.collection(COLLECTIONS.publicSettings).doc(SETTINGS_DOC_ID).get();
    _settings = {
      ...DEFAULT_SETTINGS,
      ...(settingsSnap.exists ? settingsSnap.data() : {}),
      staffUsers: [],
    };
  }
  async function _loadLeavesForStudentNos(studentNos) {
    if (!_db) {
      _leaves = [];
      return;
    }
    const uniqueStudentNos = [...new Set((studentNos || [])
      .map(no => String(no || '').trim())
      .filter(Boolean))];
    if (!uniqueStudentNos.length) {
      _leaves = [];
      return;
    }
    const loaded = [];
    for (let start = 0; start < uniqueStudentNos.length; start += 10) {
      const chunk = uniqueStudentNos.slice(start, start + 10);
      const snapshot = await _db.collection(COLLECTIONS.leaves).where('studentNo', 'in', chunk).get();
      snapshot.docs.forEach(doc => {
        const normalized = _normalizeLeaveRecord({ id: doc.id, ...doc.data() });
        if (normalized) loaded.push(normalized);
      });
    }
    const byId = new Map();
    loaded.forEach(leaveRecord => byId.set(leaveRecord.id, leaveRecord));
    _leaves = [...byId.values()];
  }
  async function _loadPortalLeavesForEmail(email) {
    const target = String(email || '').trim().toLowerCase();
    if (!_db || !target) {
      _leaves = [];
      return;
    }
    const byId = new Map();
    const addSnapshot = snapshot => {
      snapshot.docs.forEach(doc => {
        const normalized = _normalizeLeaveRecord({ id: doc.id, ...doc.data() });
        if (normalized) byId.set(normalized.id, normalized);
      });
    };
    const snapshots = await Promise.all([
      _db.collection(COLLECTIONS.leaves).where('studentEmails', 'array-contains', target).get(),
      _db.collection(COLLECTIONS.leaves).where('parentEmails', 'array-contains', target).get(),
    ]);
    snapshots.forEach(addSnapshot);
    _leaves = [...byId.values()];
  }
  async function _loadPortalStudentsForEmail(email) {
    const target = String(email || '').trim().toLowerCase();
    if (!_db || !target) return { students: [], usedFallback: false };
    const byId = new Map();
    const addSnapshot = snapshot => {
      snapshot.docs.forEach(doc => {
        const normalized = _normalizeStudentRecord({ id: doc.id, ...doc.data() });
        if (normalized) byId.set(normalized.id, normalized);
      });
    };
    const querySpecs = [
      ['email', '==', target],
      ['studentEmailList', 'array-contains', target],
      ['parentEmailList', 'array-contains', target],
      ['fatherEmail', '==', target],
      ['motherEmail', '==', target],
      ['parentEmail', '==', target],
    ];
    const snapshots = await Promise.all(querySpecs.map(([field, op, value]) =>
      _db.collection(COLLECTIONS.students).where(field, op, value).get()
    ));
    snapshots.forEach(addSnapshot);
    return { students: [...byId.values()], usedFallback: false };
  }
  async function _loadAllData() {
    const [
      students,
      leaves,
      tardies,
      holidays,
    ] = await Promise.all([
      _loadCollection(COLLECTIONS.students, _normalizeStudentRecord),
      _loadCollection(COLLECTIONS.leaves, _normalizeLeaveRecord),
      _loadCollection(COLLECTIONS.tardies, _normalizeTardyRecord),
      _loadCollection(COLLECTIONS.holidays, _normalizeHolidayRecord),
    ]);
    _students = students;
    _leaves = leaves;
    _tardies = tardies;
    _holidays = holidays;
    await _loadSettingsDoc();
  }
  function _classScopeVariants(className) {
    const raw = String(className || '').trim();
    const normalized = _normalizeHomeroomClass(raw);
    return [...new Set([
      raw,
      normalized,
      normalized ? ('G' + normalized) : '',
      raw && raw.charAt(0).toUpperCase() === 'G' ? raw.slice(1) : '',
    ].map(value => String(value || '').trim()).filter(Boolean))];
  }
  function _adminScopeForEmail(email) {
    const target = String(email || '').trim().toLowerCase();
    const superAdmins = (Array.isArray(window.__SUPER_ADMINS__) ? window.__SUPER_ADMINS__ : [])
      .map(item => String(item || '').trim().toLowerCase())
      .filter(Boolean);
    const settings = _cloneSettings();
    const staff = (settings.staffUsers || []).find(user => user.email === target) || null;
    const roles = staff && Array.isArray(staff.roles)
      ? staff.roles.map(role => String(role || '').trim().toLowerCase()).filter(Boolean)
      : [];
    const isSuperAdmin = superAdmins.includes(target);
    const isGlobal = isSuperAdmin || roles.some(role => ['admin', 'discipline', 'dean'].includes(role));
    const homeroomClass = staff && staff.homeroomClass ? staff.homeroomClass : '';
    return {
      authorized: Boolean(target && (isSuperAdmin || staff)),
      email: target,
      staff,
      roles: isSuperAdmin && !roles.length ? ['admin'] : roles,
      isSuperAdmin,
      global: isGlobal,
      homeroomClass,
      classVariants: _classScopeVariants(homeroomClass),
    };
  }
  async function _loadAdminScopedData(email) {
    await _loadSettingsDoc();
    const scope = _adminScopeForEmail(email);
    if (!scope.authorized) {
      throw new Error('This account is not authorized for admin access.');
    }
    if (scope.global) {
      const [students, leaves, tardies, holidays] = await Promise.all([
        _loadCollection(COLLECTIONS.students, _normalizeStudentRecord),
        _loadCollection(COLLECTIONS.leaves, _normalizeLeaveRecord),
        _loadCollection(COLLECTIONS.tardies, _normalizeTardyRecord),
        _loadCollection(COLLECTIONS.holidays, _normalizeHolidayRecord),
      ]);
      _students = students;
      _leaves = leaves;
      _tardies = tardies;
      _holidays = holidays;
      return scope;
    }
    if (!scope.classVariants.length) {
      _students = [];
      _leaves = [];
      _tardies = [];
      _holidays = await _loadCollection(COLLECTIONS.holidays, _normalizeHolidayRecord);
      return scope;
    }
    const [students, leaves, tardies, holidays] = await Promise.all([
      _loadCollectionByExactValues(COLLECTIONS.students, 'className', scope.classVariants, _normalizeStudentRecord),
      _loadCollectionByExactValues(COLLECTIONS.leaves, 'className', scope.classVariants, _normalizeLeaveRecord),
      _loadCollectionByExactValues(COLLECTIONS.tardies, 'className', scope.classVariants, _normalizeTardyRecord),
      _loadCollection(COLLECTIONS.holidays, _normalizeHolidayRecord),
    ]);
    _students = students;
    _leaves = leaves;
    _tardies = tardies;
    _holidays = holidays;
    return scope;
  }
  // ---------------------------------------------------------------------------
  // Helpers – general
  // ---------------------------------------------------------------------------
  function _generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  // Firestore doc IDs become part of onclick attributes & URL fragments in
  // the UI. Constrain to a safe subset so that no caller can sneak in
  // quotes / angle brackets that would break out of an attribute context.
  function _sanitizeDocId(rawId) {
    const text = String(rawId || '').trim();
    if (!text) return _generateId();
    return /^[A-Za-z0-9_-]{1,64}$/.test(text) ? text : _generateId();
  }
  function _defaultEmail(studentNo) {
    return studentNo ? String(studentNo).trim() + '@ibsh.tw' : '';
  }
  function _asDate(value) {
    if (!value) return null;
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : value;
    }
    if (value && typeof value.toDate === 'function') {
      const parsed = value.toDate();
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  function _toDateStr(value) {
    if (!value) return '';
    if (typeof value === 'string') {
      return value.slice(0, 10);
    }
    const parsed = _asDate(value);
    return parsed ? parsed.toISOString().slice(0, 10) : '';
  }
  function _toTimeStr(value) {
    if (!value) return '';
    if (typeof value === 'string') {
      const match = value.match(/(\d{2}:\d{2})/);
      return match ? match[1] : value.slice(0, 5);
    }
    const parsed = _asDate(value);
    if (!parsed) return '';
    return String(parsed.getHours()).padStart(2, '0') + ':' + String(parsed.getMinutes()).padStart(2, '0');
  }
  function _toIsoString(value, fallback) {
    if (!value) return fallback || '';
    if (typeof value === 'string') return value;
    const parsed = _asDate(value);
    return parsed ? parsed.toISOString() : (fallback || '');
  }
  function _normalizeDateTime(value, fallbackDate, fallbackTime) {
    if (typeof value === 'string' && value) {
      if (value.includes('T')) return value.slice(0, 16);
      if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(value)) {
        return value.slice(0, 10) + 'T' + value.slice(11, 16);
      }
    }
    const parsed = _asDate(value);
    if (parsed) {
      return parsed.toISOString().slice(0, 16);
    }
    const dateStr = _toDateStr(fallbackDate);
    const timeStr = _toTimeStr(fallbackTime);
    return dateStr ? dateStr + 'T' + (timeStr || '00:00') : '';
  }
  function _timeToMinutes(timeStr) {
    const [hours, minutes] = String(timeStr || '00:00').split(':').map(Number);
    return (hours || 0) * 60 + (minutes || 0);
  }
  function _compareClassNames(a, b) {
    return CLASS_NAME_COLLATOR.compare(String(a || ''), String(b || ''));
  }
  function _parsePeriods(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string') {
      const match = value.match(/\d+/);
      return match ? parseInt(match[0], 10) : 0;
    }
    return 0;
  }
  function _splitEmailList(value) {
    const values = Array.isArray(value) ? value : [value];
    return values
      .flatMap(item => String(item || '').split(/[,\uFF0C;\uFF1B, \/\s]+/))
      .map(email => email.trim().toLowerCase())
      .filter(Boolean);
  }
  function _uniqueEmails(values) {
    return [...new Set(_splitEmailList(values))];
  }
  function _normalizeEmailListString(value) {
    return _uniqueEmails(value).join(', ');
  }
  function _normalizeStudentRecord(student) {
    if (!student) return null;
    const studentNo = String(student.studentNo || student.studentId || '').trim();
    const fatherEmail = _normalizeEmailListString(student.fatherEmail);
    const motherEmail = _normalizeEmailListString(student.motherEmail);
    const legacyParentEmail = _normalizeEmailListString([student.parentEmail, student.guardianEmail]);
    const parentEmail = legacyParentEmail || _uniqueEmails([fatherEmail, motherEmail]).join(', ');
    const email = String(student.email || _defaultEmail(studentNo)).trim().toLowerCase();
    const parentEmailList = _uniqueEmails([student.parentEmailList, fatherEmail, motherEmail, parentEmail]);
    const record = {
      id: _sanitizeDocId(student.id),
      chineseName: String(student.chineseName || student.studentName || '').trim(),
      studentNo: studentNo,
      studentId: studentNo,
      className: String(student.className || student.studentClass || '').trim(),
      seatNo: String(student.seatNo || '').trim(),
      englishName: String(student.englishName || '').trim(),
      email: email,
      studentEmailList: _uniqueEmails([student.studentEmailList, email]),
      fatherName: String(student.fatherName || '').trim(),
      fatherPhone: String(student.fatherPhone || '').trim(),
      fatherEmail: fatherEmail,
      motherName: String(student.motherName || '').trim(),
      motherPhone: String(student.motherPhone || '').trim(),
      motherEmail: motherEmail,
      parentEmail: parentEmail,
      parentEmailList: parentEmailList,
    };
    if (!record.studentNo && !record.chineseName && !record.className) {
      return null;
    }
    return record;
  }
  // Sanitized student snapshot stored in /publicStudents for the tardy
  // kiosk (anonymous sign-in). Intentionally drops parent emails, phones,
  // and other PII — only what the kiosk dropdown needs.
  function _publicStudentFrom(student) {
    if (!student || !student.studentNo) return null;
    return {
      studentNo: String(student.studentNo || '').trim(),
      studentId: String(student.studentNo || '').trim(),
      className: String(student.className || '').trim(),
      seatNo: String(student.seatNo || '').trim(),
      chineseName: String(student.chineseName || '').trim(),
      englishName: String(student.englishName || '').trim(),
    };
  }
  async function _writePublicStudent(student) {
    if (!_db || !student || !student.id) return;
    const payload = _publicStudentFrom(student);
    if (!payload) return;
    await _db.collection(COLLECTIONS.publicStudents).doc(student.id).set(payload);
  }
  async function _deletePublicStudent(id) {
    if (!_db || !id) return;
    await _db.collection(COLLECTIONS.publicStudents).doc(id).delete();
  }
  async function _writePublicStudentsBatch(students) {
    if (!_db || !students || !students.length) return;
    for (let start = 0; start < students.length; start += BATCH_LIMIT) {
      const batch = _db.batch();
      students.slice(start, start + BATCH_LIMIT).forEach(student => {
        if (!student || !student.id) return;
        const payload = _publicStudentFrom(student);
        if (!payload) return;
        batch.set(_db.collection(COLLECTIONS.publicStudents).doc(student.id), payload);
      });
      await batch.commit();
    }
  }
  function _studentParentEmails(student) {
    if (Array.isArray(student && student.parentEmailList) && student.parentEmailList.length) {
      return _uniqueEmails(student.parentEmailList);
    }
    const currentParentEmails = _uniqueEmails([student && student.fatherEmail, student && student.motherEmail]);
    return currentParentEmails.length ? currentParentEmails : _uniqueEmails([student && student.parentEmail]);
  }
  function _studentSelfEmails(student) {
    return _uniqueEmails([student && student.studentEmailList, student && student.email]);
  }
  function _sameStringArray(a, b) {
    const left = (Array.isArray(a) ? a : []).map(String).sort();
    const right = (Array.isArray(b) ? b : []).map(String).sort();
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }
  async function _syncLeaveContactSnapshotsForStudent(student) {
    if (!student || !student.studentNo) return 0;
    const parentEmails = _studentParentEmails(student);
    const studentEmails = _studentSelfEmails(student);
    const changed = [];
    _leaves.forEach(leaveRecord => {
      if (!leaveRecord || leaveRecord.archived) return;
      if (String(leaveRecord.studentNo || '').trim() !== String(student.studentNo || '').trim()) return;
      let touched = false;
      if (!_sameStringArray(leaveRecord.parentEmails, parentEmails)) {
        leaveRecord.parentEmails = parentEmails.slice();
        touched = true;
      }
      if (!_sameStringArray(leaveRecord.studentEmails, studentEmails)) {
        leaveRecord.studentEmails = studentEmails.slice();
        touched = true;
      }
      if (touched) changed.push({ ...leaveRecord });
    });
    if (changed.length) {
      await _queueWrite(() => _commitChunkedSet(COLLECTIONS.leaves, changed));
    }
    return changed.length;
  }
  function _normalizeLeaveRecord(record) {
    if (!record) return null;
    const studentNo = String(record.studentNo || record.studentId || '').trim();
    const className = String(record.className || record.studentClass || '').trim();
    const leaveType = String(record.leaveType || record.leaveReason || '').trim();
    const reason = String(record.reason || record.parentNote || '').trim();
    const parentEmails = Array.isArray(record.parentEmails)
      ? record.parentEmails
      : [
          ...(Array.isArray(record.authorizedParentEmails) ? record.authorizedParentEmails : []),
          record.parentEmail,
          record.fatherEmail,
          record.motherEmail,
        ];
    const studentEmails = Array.isArray(record.studentEmails)
      ? record.studentEmails
      : [
          ...(Array.isArray(record.authorizedStudentEmails) ? record.authorizedStudentEmails : []),
          record.studentEmail,
          record.email,
        ];
    const fromDate = _toDateStr(record.fromDate || record.startTime);
    const toDate = _toDateStr(record.toDate || record.endTime || fromDate);
    const fromTime = _toTimeStr(record.fromTime || record.startTime || DEFAULT_LEAVE_TIMES.fromTime) || DEFAULT_LEAVE_TIMES.fromTime;
    const toTime = _toTimeStr(record.toTime || record.endTime || DEFAULT_LEAVE_TIMES.toTime) || DEFAULT_LEAVE_TIMES.toTime;
    const startTime = _normalizeDateTime(record.startTime, fromDate, fromTime);
    const endTime = _normalizeDateTime(record.endTime, toDate || fromDate, toTime);
    const createdAt = _toIsoString(record.createdAt, _toIsoString(record.submittedAt, new Date().toISOString()));
    const periods = _parsePeriods(record.periods != null ? record.periods : record.totalPeriods);
    const stageHistoryRaw = Array.isArray(record.stageHistory) ? record.stageHistory : [];
    const stageHistory = stageHistoryRaw.map(entry => {
      const out = {
        stageId: String((entry && entry.stageId) || '').trim(),
        stageName: String((entry && entry.stageName) || '').trim(),
        action: String((entry && entry.action) || '').trim(),
        by: String((entry && entry.by) || '').trim(),
        at: _toIsoString(entry && entry.at, ''),
        comment: String((entry && entry.comment) || '').trim(),
      };
      // Preserve the signature data URL when present (added on approve).
      if (entry && typeof entry.signature === 'string' && entry.signature) {
        out.signature = entry.signature;
      }
      return out;
    });
    const currentStageIndexRaw = record.currentStageIndex;
    const currentStageIndex = (typeof currentStageIndexRaw === 'number' && Number.isFinite(currentStageIndexRaw))
      ? currentStageIndexRaw
      : 0;
    return {
      id: _sanitizeDocId(record.id),
      studentNo: studentNo,
      studentId: studentNo,
      className: className,
      studentClass: className,
      seatNo: String(record.seatNo || '').trim(),
      chineseName: String(record.chineseName || record.studentName || '').trim(),
      englishName: String(record.englishName || '').trim(),
      leaveType: leaveType,
      leaveReason: leaveType,
      fromDate: fromDate,
      toDate: toDate || fromDate,
      fromTime: fromTime,
      toTime: toTime,
      fullDay: Boolean(record.fullDay),
      startTime: startTime,
      endTime: endTime,
      periods: periods,
      totalPeriods: periods,
      reason: reason,
      parentNote: reason,
      parentEmails: _uniqueEmails(parentEmails),
      studentEmails: _uniqueEmails(studentEmails),
      deanSignature: String(record.deanSignature || '').trim(),
      doctorNote: Boolean(record.doctorNote),
      priorPhoneNotice: Boolean(record.priorPhoneNotice),
      priorApprovalRequired: Boolean(record.priorApprovalRequired),
      personalPriorApproval: Boolean(record.personalPriorApproval),
      status: String(record.status || 'pending').trim(),
      currentStageIndex: currentStageIndex,
      stageHistory: stageHistory,
      isWalkin: Boolean(record.isWalkin),
      source: String(record.source || record.leaveSource || '').trim(),
      // submittedBy is compared against the lowercased Firebase Auth email in
      // Firestore rules — store lowercased to keep that check reliable.
      submittedBy: String(record.submittedBy || '').trim().toLowerCase(),
      submittedByRole: String(record.submittedByRole || '').trim(),
      reconciliationStatus: String(record.reconciliationStatus || '').trim(),
      reconciledByLeaveId: String(record.reconciledByLeaveId || '').trim(),
      reconciledAt: _toIsoString(record.reconciledAt, ''),
      reconciledBy: String(record.reconciledBy || '').trim(),
      archived: Boolean(record.archived),
      archiveReason: String(record.archiveReason || '').trim(),
      archivedAt: _toIsoString(record.archivedAt, ''),
      archivedBy: String(record.archivedBy || '').trim(),
      sentBack: Boolean(record.sentBack),
      sentBackReason: String(record.sentBackReason || '').trim(),
      sentBackAt: _toIsoString(record.sentBackAt, ''),
      returnConfirmed: Boolean(record.returnConfirmed),
      returnDate: String(record.returnDate || '').trim(),
      createdAt: createdAt,
      submittedAt: _toIsoString(record.submittedAt, createdAt),
    };
  }
  function _normalizeTardyRecord(record) {
    if (!record) return null;
    const studentNo = String(record.studentNo || record.studentId || '').trim();
    return {
      id: _sanitizeDocId(record.id),
      studentNo: studentNo,
      studentId: studentNo,
      className: String(record.className || record.studentClass || '').trim(),
      seatNo: String(record.seatNo || '').trim(),
      chineseName: String(record.chineseName || record.studentName || '').trim(),
      englishName: String(record.englishName || '').trim(),
      reason: String(record.reason || '').trim(),
      date: _toDateStr(record.date || record.createdAt || new Date()),
      createdAt: _toIsoString(record.createdAt, new Date().toISOString()),
    };
  }
  function _normalizeHolidayRecord(holiday) {
    if (!holiday) return null;
    const startDate = _toDateStr(holiday.startDate || holiday.date);
    let endDate = _toDateStr(holiday.endDate || holiday.startDate || holiday.date);
    if (!startDate) return null;
    if (!endDate || endDate < startDate) endDate = startDate;
    return {
      id: _sanitizeDocId(holiday.id),
      date: startDate,
      startDate: startDate,
      endDate: endDate,
      name: String(holiday.name || '').trim(),
      type: String(holiday.type || 'manual').trim(),
    };
  }
  function _inferWorkflowMeta(stage) {
    const id = String((stage && stage.id) || '').trim().toLowerCase();
    const name = String((stage && (stage.name || stage.label)) || '').trim().toLowerCase();
    const text = id + ' ' + name;
    const meta = {
      approverType: stage && stage.approverType ? String(stage.approverType).trim() : '',
      staffRole: stage && stage.staffRole ? String(stage.staffRole).trim() : '',
      condition: stage && stage.condition && typeof stage.condition === 'object' ? stage.condition : null,
    };
    if (!meta.approverType) {
      meta.approverType = /parent|guardian|Parent/i.test(text) ? 'parent' : 'staff';
    }
    if (meta.approverType === 'staff' && !meta.staffRole) {
      if (/homeroom|Homeroom Teacher/i.test(text)) meta.staffRole = 'homeroom';
      else if (/discipline|disciplinarian|student affairs/i.test(text)) meta.staffRole = 'discipline';
      else if (/dean|director/i.test(text)) meta.staffRole = 'dean';
      else if (/admin|administrator|system admin/i.test(text)) meta.staffRole = 'admin';
    }
    if (!meta.condition && /dean|director/i.test(text)) {
      meta.condition = { type: 'minDays', value: 3 };
    }
    return meta;
  }
  function _normalizeWorkflow(value) {
    if (!Array.isArray(value)) return DEFAULT_APPROVAL_WORKFLOW.slice();
    const cleaned = value
      .map((stage, index) => {
        if (!stage) return null;
        const id = String(stage.id || '').trim() || ('stage-' + (index + 1));
        const name = String(stage.name || stage.label || '').trim();
        if (!name) return null;
        const inferred = _inferWorkflowMeta(stage);
        const approverType = inferred.approverType || 'staff';
        const staffRole = inferred.staffRole || '';
        const condition = inferred.condition && typeof inferred.condition === 'object'
          ? {
              type: String(inferred.condition.type || '').trim(),
              value: Number(inferred.condition.value) || 0,
            }
          : null;
        const out = { id, name, approverType };
        if (approverType === 'staff' && staffRole) out.staffRole = staffRole;
        if (condition && condition.type) out.condition = condition;
        return out;
      })
      .filter(Boolean);
    return cleaned.length ? cleaned : DEFAULT_APPROVAL_WORKFLOW.slice();
  }
  function _normalizeHomeroomClass(value) {
    const text = String(value || '')
      .trim()
      .toUpperCase()
      .replace(/Ａ/g, 'A')
      .replace(/Ｂ/g, 'B')
      .replace(/GRADE/g, '')
      .replace(/[.\s_\-\/()]+/g, '');
    const match = text.match(/^G?([1-9]|1[0-2])([AB])$/);
    return match ? (String(Number(match[1])) + match[2]) : '';
  }
  function _normalizeStaffUsers(value) {
    if (!Array.isArray(value)) return [];
    return value.map((u, i) => {
      if (!u) return null;
      const email = String(u.email || '').trim().toLowerCase();
      if (!email) return null;
      const rolesRaw = Array.isArray(u.roles)
        ? u.roles
        : (u.role ? [u.role] : []);
      const roles = rolesRaw.map(r => String(r || '').trim()).filter(Boolean);
      const homeroomClass = _normalizeHomeroomClass(u.homeroomClass || u.className || '');
      const normalized = {
        id: String(u.id || ('staff-' + (i + 1))).trim(),
        name: String(u.name || '').trim(),
        email,
        roles,
      };
      if (homeroomClass) normalized.homeroomClass = homeroomClass;
      return normalized;
    }).filter(Boolean);
  }
  function _notificationRecipientsFromStaffUsers(value) {
    const routes = {
      homeroom: {},
      discipline: [],
      dean: [],
    };
    _normalizeStaffUsers(value).forEach(user => {
      const email = String(user.email || '').trim().toLowerCase();
      if (!email) return;
      const roles = (Array.isArray(user.roles) ? user.roles : [])
        .map(role => String(role || '').trim().toLowerCase());
      if (roles.includes('homeroom') && user.homeroomClass) {
        const cls = _normalizeHomeroomClass(user.homeroomClass);
        if (cls) {
          routes.homeroom[cls] = routes.homeroom[cls] || [];
          routes.homeroom[cls].push(email);
        }
      }
      if (roles.includes('discipline')) routes.discipline.push(email);
      if (roles.includes('dean')) routes.dean.push(email);
    });
    Object.keys(routes.homeroom).forEach(cls => {
      routes.homeroom[cls] = [...new Set(routes.homeroom[cls])];
    });
    routes.discipline = [...new Set(routes.discipline)];
    routes.dean = [...new Set(routes.dean)];
    return routes;
  }
  function _normalizeExamPeriods(value) {
    if (!Array.isArray(value)) return [];
    return value
      .map((item, index) => {
        if (!item) return null;
        const startDate = _toDateStr(item.startDate || item.date || item.fromDate);
        let endDate = _toDateStr(item.endDate || item.toDate || startDate);
        if (!startDate) return null;
        if (!endDate || endDate < startDate) endDate = startDate;
        const type = String(item.type || '').trim().toLowerCase() === 'final' ? 'final' : 'midterm';
        const fallbackName = type === 'final'
          ? 'Final Exam Week'
          : 'Midterm Exam Week';
        return {
          id: _sanitizeDocId(item.id || ('exam-' + (index + 1))),
          type,
          name: String(item.name || fallbackName).trim(),
          startDate,
          endDate,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.startDate.localeCompare(b.startDate) || a.endDate.localeCompare(b.endDate) || a.name.localeCompare(b.name));
  }
  function _cloneSettings() {
    const base = {
      ...DEFAULT_SETTINGS,
      ..._settings,
    };
    base.approvalWorkflow = _normalizeWorkflow(base.approvalWorkflow);
    base.staffUsers = _normalizeStaffUsers(base.staffUsers);
    base.tardyReasonSuggestions = (Array.isArray(base.tardyReasonSuggestions)
      ? base.tardyReasonSuggestions
      : DEFAULT_TARDY_REASON_SUGGESTIONS)
      .map(reason => String(reason || '').trim())
      .filter(Boolean);
    base.examPeriods = _normalizeExamPeriods(base.examPeriods);
    // Flat lowercase email list — used by Firestore security rules to identify staff.
    base.staffEmails = base.staffUsers
      .map(u => String(u.email || '').trim().toLowerCase())
      .filter(Boolean);
    // Flat email→roles map — used by Firestore security rules for role-based gating.
    base.staffRoleMap = base.staffUsers.reduce((acc, u) => {
      const email = String(u.email || '').trim().toLowerCase();
      if (email) acc[email] = Array.isArray(u.roles) ? u.roles.slice() : [];
      return acc;
    }, {});
    // Email→homeroomClass map — used to scope homeroom teachers in rules.
    base.staffHomeroomMap = base.staffUsers.reduce((acc, u) => {
      const email = String(u.email || '').trim().toLowerCase();
      if (email && u.homeroomClass) acc[email] = u.homeroomClass;
      return acc;
    }, {});
    return base;
  }
  // ---------------------------------------------------------------------------
  // Initialisation
  // ---------------------------------------------------------------------------
  async function _initFirebase() {
    const firebaseNs = _getFirebaseNamespace();
    const config = _getFirebaseConfig();
    if (!firebaseNs || !config) {
      throw new Error('Firebase config or SDK is missing.');
    }
    if (typeof firebaseNs.firestore !== 'function') {
      throw new Error('Firestore SDK is not loaded.');
    }
    _app = firebaseNs.apps && firebaseNs.apps.length
      ? firebaseNs.app()
      : firebaseNs.initializeApp(config);
    _db = firebaseNs.firestore();
  }
  async function init() {
    if (_initPromise) return _initPromise;
    _initPromise = (async () => {
      _clearLegacyStorage();
      _resetState();
      try {
        await _initFirebase();
        await _loadAllData();
        _setStatus('firebase', null, { scope: 'full' });
        console.log('[AppDB] Initialised in Firebase mode – students:', _students.length,
          '| leaves:', _leaves.length,
          '| tardies:', _tardies.length,
          '| holidays:', _holidays.length);
      } catch (error) {
        _db = null;
        _app = null;
        _setStatus('memory', error && error.message ? error.message : 'Firebase initialisation failed.');
        console.error('[AppDB] Falling back to memory mode:', error);
      }
    })();
    return _initPromise;
  }
  async function initForAdmin(email) {
    const key = String(email || '').trim().toLowerCase();
    if (_adminInitPromise && _adminInitKey === key) return _adminInitPromise;
    _adminInitKey = key;
    _adminInitPromise = (async () => {
      _clearLegacyStorage();
      _resetState();
      try {
        await _initFirebase();
        const scope = await _loadAdminScopedData(key);
        _setStatus('firebase', null, {
          scope: 'admin',
          adminEmail: key,
          adminDataScope: scope.global ? 'global' : 'homeroom',
          homeroomClass: scope.homeroomClass || '',
          loadedStudentCount: _students.length,
          loadedLeaveCount: _leaves.length,
          loadedTardyCount: _tardies.length,
        });
        console.log('[AppDB] Initialised admin scope – data:', scope.global ? 'global' : ('homeroom ' + (scope.homeroomClass || 'none')),
          '| students:', _students.length,
          '| leaves:', _leaves.length,
          '| tardies:', _tardies.length,
          '| holidays:', _holidays.length);
      } catch (error) {
        _db = null;
        _app = null;
        _setStatus('memory', error && error.message ? error.message : 'Firebase admin initialisation failed.', { scope: 'admin' });
        console.error('[AppDB] Admin scope failed, falling back to memory mode:', error);
      }
    })();
    return _adminInitPromise;
  }
  async function initForPortal(email) {
    const key = String(email || '').trim().toLowerCase();
    if (_portalInitPromise && _portalInitKey === key) return _portalInitPromise;
    _portalInitKey = key;
    _portalInitPromise = (async () => {
      _clearLegacyStorage();
      _resetState();
      try {
        await _initFirebase();
        const [studentLookup, holidays] = await Promise.all([
          _loadPortalStudentsForEmail(key),
          _loadCollection(COLLECTIONS.holidays, _normalizeHolidayRecord),
          _loadPublicSettingsDoc(),
        ]);
        _students = studentLookup.students;
        _holidays = holidays;
        _tardies = [];
        await _loadPortalLeavesForEmail(key);
        _setStatus('firebase', null, {
          scope: 'portal',
          portalEmail: key,
          loadedStudentCount: _students.length,
          loadedLeaveCount: _leaves.length,
          studentLookupFallback: !!studentLookup.usedFallback,
        });
        console.log('[AppDB] Initialised portal scope – students:', _students.length,
          '| scoped leaves:', _leaves.length,
          '| holidays:', _holidays.length,
          '| student fallback:', !!studentLookup.usedFallback);
      } catch (error) {
        _db = null;
        _app = null;
        _setStatus('memory', error && error.message ? error.message : 'Firebase portal initialisation failed.', { scope: 'portal' });
        console.error('[AppDB] Portal scope failed, falling back to memory mode:', error);
      }
    })();
    return _portalInitPromise;
  }
  async function initForTardy() {
    if (_tardyInitPromise) return _tardyInitPromise;
    _tardyInitPromise = (async () => {
      _clearLegacyStorage();
      _resetState();
      try {
        await _initFirebase();
        // Tardy kiosk runs under anonymous sign-in, so it MUST NOT read the
        // private /students collection (which contains parent emails and
        // phones). Read the sanitized /publicStudents copy instead.
        const [publicStudents, holidays] = await Promise.all([
          _loadCollection(COLLECTIONS.publicStudents, _normalizeStudentRecord),
          _loadCollection(COLLECTIONS.holidays, _normalizeHolidayRecord),
          _loadPublicSettingsDoc(),
        ]);
        _students = publicStudents;
        _holidays = holidays;
        _leaves = [];
        _tardies = [];
        _setStatus('firebase', null, { scope: 'tardy' });
        console.log('[AppDB] Initialised tardy scope – publicStudents:', _students.length,
          '| holidays:', _holidays.length);
      } catch (error) {
        _db = null;
        _app = null;
        _setStatus('memory', error && error.message ? error.message : 'Firebase tardy initialisation failed.', { scope: 'tardy' });
        console.error('[AppDB] Tardy scope failed, falling back to memory mode:', error);
      }
    })();
    return _tardyInitPromise;
  }
  function status() {
    return { ..._status };
  }
  // ---------------------------------------------------------------------------
  // Students
  // ---------------------------------------------------------------------------
  function students() {
    return _students.slice();
  }
  async function addStudent(student) {
    const record = _normalizeStudentRecord(student);
    if (!record) return null;
    _students.push(record);
    await _queueWrite(async () => {
      await _db.collection(COLLECTIONS.students).doc(record.id).set(_stripUndefined({
        ...record,
        id: undefined,
      }));
      await _writePublicStudent(record);
    });
    return { ...record };
  }
  async function updateStudent(id, data) {
    const idx = _students.findIndex(student => student.id === id);
    if (idx === -1) return null;
    const parentFields = ['parentEmail', 'fatherName', 'fatherPhone', 'fatherEmail', 'motherName', 'motherPhone', 'motherEmail'];
    const updatesParentFields = parentFields.some(field => Object.prototype.hasOwnProperty.call(data || {}, field));
    const source = {
      ..._students[idx],
      ...data,
      id: id,
    };
    if (updatesParentFields && !Object.prototype.hasOwnProperty.call(data || {}, 'parentEmail')) {
      source.parentEmail = '';
    }
    const updated = _normalizeStudentRecord({
      ...source,
    });
    _students[idx] = updated;
    await _queueWrite(async () => {
      await _db.collection(COLLECTIONS.students).doc(id).set(_stripUndefined({
        ...updated,
        id: undefined,
      }));
      await _writePublicStudent(updated);
    });
    const syncedLeaves = await _syncLeaveContactSnapshotsForStudent(updated);
    return { ...updated, syncedLeaveContactSnapshots: syncedLeaves };
  }
  async function removeStudent(id) {
    const idx = _students.findIndex(student => student.id === id);
    if (idx === -1) return false;
    _students.splice(idx, 1);
    await _queueWrite(async () => {
      await _db.collection(COLLECTIONS.students).doc(id).delete();
      await _deletePublicStudent(id);
    });
    return true;
  }
  async function advanceStudentGrades(plan, onProgress) {
    if (!_db) throw new Error('Firestore is not connected.');
    const input = plan || {};
    const expectedOffset = Number(input.expectedGradeYearOffset || 0) || 0;
    const actorEmail = String(input.actorEmail || '').trim().toLowerCase();
    const operationId = String(input.operationId || _generateId()).trim();
    const settingsRef = _db.collection(COLLECTIONS.settings).doc(SETTINGS_DOC_ID);
    const initialSettingsSnapshot = await settingsRef.get();
    const initialSettings = initialSettingsSnapshot.exists ? initialSettingsSnapshot.data() : {};
    const existingOperation = initialSettings.gradeAdvanceOperation;
    let candidateOperation = null;

    if (!(existingOperation && existingOperation.status === 'running')) {
      const updates = Array.isArray(input.updates) ? input.updates : [];
      const removals = Array.isArray(input.removals) ? input.removals : [];
      const totalStudents = updates.length + removals.length;
      if (totalStudents > GRADE_ADVANCE_MAX_STUDENTS) {
        throw new Error(`Grade advancement is limited to ${GRADE_ADVANCE_MAX_STUDENTS} student records per operation.`);
      }

      const updateIds = new Set();
      const removalIds = new Set();
      const currentById = new Map(_students.map(student => [student.id, student]));
      const normalizedUpdates = updates.map(change => {
        const id = String((change && change.id) || '').trim();
        const current = currentById.get(id);
        const nextClass = String((change && change.className) || '').trim();
        const expectedClass = String((change && change.fromClassName) || '').trim();
        if (!id || !current || !nextClass) throw new Error('The grade preview contains an invalid student update. Refresh and try again.');
        if (updateIds.has(id)) throw new Error('The grade preview contains a duplicate student update.');
        if (expectedClass && String(current.className || '').trim() !== expectedClass) {
          throw new Error(`Student ${current.studentNo || id} changed after the preview. Refresh before applying grades.`);
        }
        updateIds.add(id);
        return { id, fromClassName: expectedClass, className: nextClass };
      });
      const normalizedRemovals = removals.map(item => {
        const id = String((item && item.id) || item || '').trim();
        const current = currentById.get(id);
        const expectedClass = String((item && item.fromClassName) || '').trim();
        if (!id || !current) throw new Error('The grade preview contains an invalid graduated student. Refresh and try again.');
        if (removalIds.has(id) || updateIds.has(id)) throw new Error('The grade preview contains a duplicate student record.');
        if (expectedClass && String(current.className || '').trim() !== expectedClass) {
          throw new Error(`Student ${current.studentNo || id} changed after the preview. Refresh before applying grades.`);
        }
        removalIds.add(id);
        return { id, fromClassName: expectedClass };
      });
      if (!normalizedUpdates.length && !normalizedRemovals.length) {
        return { advanced: 0, graduated: 0, mirrorSynced: true, operationId };
      }
      const startedAt = new Date().toISOString();
      candidateOperation = {
        id: operationId,
        status: 'running',
        actorEmail,
        expectedGradeYearOffset: expectedOffset,
        startedAt,
        updatedAt: startedAt,
        nextIndex: 0,
        total: normalizedUpdates.length + normalizedRemovals.length,
        updates: normalizedUpdates,
        removals: normalizedRemovals,
      };
    }

    let activeOperation = await _queueWrite(() => _db.runTransaction(async transaction => {
      const settingsSnapshot = await transaction.get(settingsRef);
      const remoteSettings = settingsSnapshot.exists ? settingsSnapshot.data() : {};
      const remoteOffset = Number(remoteSettings.gradeYearOffset || 0) || 0;
      const remoteOperation = remoteSettings.gradeAdvanceOperation;
      if (remoteOperation && remoteOperation.status === 'running') {
        return remoteOperation;
      }
      if (!candidateOperation || remoteOffset !== candidateOperation.expectedGradeYearOffset) {
        throw new Error('The grade roster version changed after this preview. Close the dialog, refresh, and review the new counts.');
      }
      transaction.set(settingsRef, { gradeAdvanceOperation: candidateOperation }, { merge: true });
      return candidateOperation;
    }));

    const activeUpdates = Array.isArray(activeOperation.updates) ? activeOperation.updates : [];
    const activeRemovals = Array.isArray(activeOperation.removals) ? activeOperation.removals : [];
    const operationEntries = [
      ...activeUpdates.map(change => ({ type: 'update', ...change })),
      ...activeRemovals.map(change => ({ type: 'remove', ...change })),
    ];
    if (!activeOperation.id || operationEntries.length !== Number(activeOperation.total || 0)) {
      throw new Error('The saved grade advancement operation is incomplete. Contact the system administrator before retrying.');
    }
    if (operationEntries.length > GRADE_ADVANCE_MAX_STUDENTS) {
      throw new Error(`The saved grade advancement operation exceeds the ${GRADE_ADVANCE_MAX_STUDENTS}-student limit.`);
    }
    _settings = { ..._settings, gradeAdvanceOperation: activeOperation };

    const reportProgress = detail => {
      if (typeof onProgress === 'function') onProgress(detail);
    };
    reportProgress({
      phase: 'roster',
      completed: Number(activeOperation.nextIndex || 0),
      total: operationEntries.length,
    });

    while (Number(activeOperation.nextIndex || 0) < operationEntries.length) {
      activeOperation = await _queueWrite(() => _db.runTransaction(async transaction => {
        const settingsSnapshot = await transaction.get(settingsRef);
        const remoteSettings = settingsSnapshot.exists ? settingsSnapshot.data() : {};
        const remoteOperation = remoteSettings.gradeAdvanceOperation;
        if (!remoteOperation || remoteOperation.status !== 'running' || remoteOperation.id !== activeOperation.id) {
          throw new Error('The grade advancement operation changed while it was running. Refresh before continuing.');
        }
        const start = Number(remoteOperation.nextIndex || 0);
        const end = Math.min(start + GRADE_ADVANCE_CHUNK_SIZE, operationEntries.length);
        operationEntries.slice(start, end).forEach(change => {
          const studentRef = _db.collection(COLLECTIONS.students).doc(change.id);
          if (change.type === 'remove') {
            transaction.delete(studentRef);
          } else {
            transaction.update(studentRef, { className: change.className });
          }
        });
        const nextOperation = {
          ...remoteOperation,
          nextIndex: end,
          updatedAt: new Date().toISOString(),
        };
        transaction.set(settingsRef, { gradeAdvanceOperation: nextOperation }, { merge: true });
        return nextOperation;
      }));
      _settings = { ..._settings, gradeAdvanceOperation: activeOperation };
      reportProgress({
        phase: 'roster',
        completed: Number(activeOperation.nextIndex || 0),
        total: operationEntries.length,
      });
    }

    const completedAt = new Date().toISOString();
    const completedOperationId = activeOperation.id;
    const completedOffset = Number(activeOperation.expectedGradeYearOffset || 0) || 0;
    await _queueWrite(() => _db.runTransaction(async transaction => {
      const settingsSnapshot = await transaction.get(settingsRef);
      const remoteSettings = settingsSnapshot.exists ? settingsSnapshot.data() : {};
      const remoteOffset = Number(remoteSettings.gradeYearOffset || 0) || 0;
      const remoteOperation = remoteSettings.gradeAdvanceOperation;
      if (!remoteOperation && remoteOffset === completedOffset + 1 && remoteSettings.lastGradeAdvanceOperationId === completedOperationId) {
        return;
      }
      if (!remoteOperation || remoteOperation.id !== completedOperationId || Number(remoteOperation.nextIndex || 0) !== operationEntries.length) {
        throw new Error('The grade advancement operation is not ready to finish. Refresh and continue the saved operation.');
      }
      if (remoteOffset !== completedOffset) {
        throw new Error('The grade roster version changed while the operation was running. Refresh before continuing.');
      }
      transaction.set(settingsRef, {
        gradeYearOffset: remoteOffset + 1,
        gradeAdvanceOperation: null,
        lastGradeAdvanceAt: completedAt,
        lastGradeAdvanceBy: activeOperation.actorEmail || actorEmail,
        lastGradeAdvanceOperationId: completedOperationId,
        lastGradeAdvanceAdvancedCount: activeUpdates.length,
        lastGradeAdvanceGraduatedCount: activeRemovals.length,
      }, { merge: true });
    }));

    const updatedById = new Map(activeUpdates.map(change => {
      const current = _students.find(student => student.id === change.id);
      return [change.id, current ? _normalizeStudentRecord({ ...current, className: change.className }) : null];
    }));
    const removalIds = new Set(activeRemovals.map(change => change.id));
    _students = _students
      .filter(student => !removalIds.has(student.id))
      .map(student => updatedById.get(student.id) || student);
    _settings = {
      ..._settings,
      gradeYearOffset: completedOffset + 1,
      gradeAdvanceOperation: null,
      lastGradeAdvanceAt: completedAt,
      lastGradeAdvanceBy: activeOperation.actorEmail || actorEmail,
      lastGradeAdvanceOperationId: completedOperationId,
      lastGradeAdvanceAdvancedCount: activeUpdates.length,
      lastGradeAdvanceGraduatedCount: activeRemovals.length,
    };

    let mirrorSynced = true;
    try {
      reportProgress({ phase: 'public', completed: 0, total: operationEntries.length });
      await _queueWrite(async () => {
        await _writePublicStudentsBatch([...updatedById.values()].filter(Boolean));
        await _commitChunkedDelete(COLLECTIONS.publicStudents, [...removalIds]);
      });
      reportProgress({ phase: 'public', completed: operationEntries.length, total: operationEntries.length });
    } catch (error) {
      mirrorSynced = false;
      console.error('[AppDB] Grade advancement succeeded, but public student mirror sync failed:', error);
    }
    return {
      advanced: activeUpdates.length,
      graduated: activeRemovals.length,
      mirrorSynced,
      operationId: completedOperationId,
    };
  }
  async function importStudents(rows) {
    let added = 0;
    let updated = 0;
    const changed = [];
    rows.forEach(row => {
      const normalized = _normalizeStudentRecord(row);
      if (!normalized) return;
      const existing = _students.find(student =>
        normalized.studentNo && student.studentNo === normalized.studentNo
      );
      if (existing) {
        const merged = _normalizeStudentRecord({
          ...existing,
          ...normalized,
          id: existing.id,
        });
        Object.assign(existing, merged);
        changed.push({ ...existing });
        updated++;
      } else {
        _students.push(normalized);
        changed.push({ ...normalized });
        added++;
      }
    });
    await _queueWrite(async () => {
      await _commitChunkedSet(COLLECTIONS.students, changed);
      await _writePublicStudentsBatch(changed);
    });
    let syncedLeaves = 0;
    for (const student of changed) {
      syncedLeaves += await _syncLeaveContactSnapshotsForStudent(student);
    }
    return { added, updated, total: _students.length, syncedLeaves };
  }
  // Admin-triggered one-time/manual full rebuild of /publicStudents from
  // /students. Use after upgrading from a pre-/publicStudents deployment,
  // or whenever the kiosk lookup data looks stale.
  async function syncAllPublicStudents() {
    if (!_db) return { synced: 0 };
    await _writePublicStudentsBatch(_students.slice());
    return { synced: _students.length };
  }
  function getStudentsByClass(className) {
    return _students
      .filter(student => student.className === className)
      .slice()
      .sort((a, b) => (parseInt(a.seatNo, 10) || 0) - (parseInt(b.seatNo, 10) || 0));
  }
  function getStudentByNo(studentNo) {
    const found = _students.find(student => student.studentNo === studentNo);
    return found ? { ...found } : null;
  }
  function getStudentByEmail(email) {
    const target = String(email || '').trim().toLowerCase();
    if (!target) return null;
    const found = _students.find(student => {
      const studentEmail = String(student.email || '').trim().toLowerCase();
      return studentEmail && studentEmail === target;
    });
    return found ? { ...found } : null;
  }
  function getStudentsByParentEmail(email) {
    const target = String(email || '').trim().toLowerCase();
    if (!target) return [];
    return _students
      .filter(student => {
        const emails = _uniqueEmails([student.parentEmailList, student.parentEmail, student.fatherEmail, student.motherEmail]);
        return emails.includes(target);
      })
      .map(s => ({ ...s }));
  }
  function getStaffByEmail(email) {
    const target = String(email || '').trim().toLowerCase();
    if (!target) return null;
    const settings = _cloneSettings();
    const found = (settings.staffUsers || []).find(u => u.email === target);
    return found ? { ...found } : null;
  }
  function getClassList() {
    return [...new Set(_students.map(student => student.className).filter(Boolean))].sort(_compareClassNames);
  }
  // ---------------------------------------------------------------------------
  // Leaves
  // ---------------------------------------------------------------------------
  function leave() {
    return _leaves.slice();
  }
  async function addLeave(record) {
    const entry = _normalizeLeaveRecord(record);
    if (!entry) return '';
    _leaves.push(entry);
    await _queueWrite(() => _db.collection(COLLECTIONS.leaves).doc(entry.id).set(_stripUndefined({
      ...entry,
      id: undefined,
    })));
    return entry.id;
  }
  async function updateLeave(id, data) {
    const idx = _leaves.findIndex(leaveRecord => leaveRecord.id === id);
    if (idx === -1) return null;
    const updated = _normalizeLeaveRecord({
      ..._leaves[idx],
      ...data,
      id: id,
    });
    _leaves[idx] = updated;
    // Persist only the fields the caller passed in (not the full normalized
    // record). This is critical because Firestore rules check
    // `diff(resource.data).affectedKeys().hasOnly([...])` for the family /
    // walkin / contact-snapshot branches — writing back a fully renormalized
    // doc would surface spurious changes (whitespace trims, array order, etc.)
    // and cause permission-denied on legitimate updates.
    const diffPayload = _stripUndefined({ ...(data || {}) });
    delete diffPayload.id;
    if (Object.keys(diffPayload).length === 0) return { ...updated };
    await _queueWrite(() => _db.collection(COLLECTIONS.leaves).doc(id).update(diffPayload));
    return { ...updated };
  }
  async function updateLeaveTransaction(id, buildPayload) {
    if (!_db) throw new Error('Firestore is not connected.');
    const docId = String(id || '').trim();
    if (!docId) throw new Error('Leave ID is required.');
    const ref = _db.collection(COLLECTIONS.leaves).doc(docId);
    let updated = null;
    await _queueWrite(() => _db.runTransaction(async transaction => {
      const snap = await transaction.get(ref);
      if (!snap.exists) throw new Error('Leave not found.');
      const current = _normalizeLeaveRecord({ id: snap.id, ...snap.data() });
      if (!current) throw new Error('Leave data is invalid.');
      const payload = typeof buildPayload === 'function' ? buildPayload({ ...current }) : buildPayload;
      const diffPayload = _stripUndefined({ ...(payload || {}) });
      delete diffPayload.id;
      updated = _normalizeLeaveRecord({
        ...current,
        ...diffPayload,
        id: current.id,
      });
      if (Object.keys(diffPayload).length) {
        transaction.update(ref, diffPayload);
      }
    }));
    if (updated) {
      const idx = _leaves.findIndex(leaveRecord => leaveRecord.id === updated.id);
      if (idx === -1) _leaves.push(updated);
      else _leaves[idx] = updated;
      return { ...updated };
    }
    return null;
  }
  async function removeLeave(id) {
    const idx = _leaves.findIndex(leaveRecord => leaveRecord.id === id);
    if (idx === -1) return false;
    _leaves.splice(idx, 1);
    await _queueWrite(() => _db.collection(COLLECTIONS.leaves).doc(id).delete());
    return true;
  }
  function getLeavesByDate(dateStr) {
    const date = _toDateStr(dateStr);
    return _leaves.filter(leaveRecord => {
      const start = _toDateStr(leaveRecord.startTime);
      const end = _toDateStr(leaveRecord.endTime);
      return date >= start && date <= end;
    }).slice();
  }
  function getLeavesByDateRange(from, to) {
    const startDate = _toDateStr(from);
    const endDate = _toDateStr(to);
    return _leaves.filter(leaveRecord => {
      const leaveStart = _toDateStr(leaveRecord.startTime);
      const leaveEnd = _toDateStr(leaveRecord.endTime);
      return leaveStart <= endDate && leaveEnd >= startDate;
    }).slice();
  }
  function getPendingLeaves() {
    return _leaves.filter(leaveRecord => leaveRecord.status === 'pending').slice();
  }
  function getLeavesByStudentNo(studentNo) {
    const target = String(studentNo || '').trim();
    if (!target) return [];
    return _leaves.filter(leaveRecord => String(leaveRecord.studentNo || '').trim() === target).slice();
  }
  // ---------------------------------------------------------------------------
  // Tardies
  // ---------------------------------------------------------------------------
  function tardies() {
    return _tardies.slice();
  }
  async function addTardy(record) {
    const entry = _normalizeTardyRecord(record);
    if (!entry) return null;
    _tardies.push(entry);
    await _queueWrite(() => _db.collection(COLLECTIONS.tardies).doc(entry.id).set(_stripUndefined({
      ...entry,
      id: undefined,
    })));
    return { ...entry };
  }
  function getTardiesByDate(dateStr) {
    const date = _toDateStr(dateStr);
    return _tardies.filter(tardyRecord => _toDateStr(tardyRecord.date) === date).slice();
  }
  function getTardiesByDateRange(from, to) {
    const startDate = _toDateStr(from);
    const endDate = _toDateStr(to);
    return _tardies.filter(tardyRecord => {
      const date = _toDateStr(tardyRecord.date);
      return date >= startDate && date <= endDate;
    }).slice();
  }
  function getTardiesByStudentNo(studentNo) {
    const target = String(studentNo || '').trim();
    if (!target) return [];
    return _tardies.filter(tardyRecord => String(tardyRecord.studentNo || '').trim() === target).slice();
  }
  async function clearTardies() {
    const ids = _tardies.map(tardyRecord => tardyRecord.id);
    _tardies = [];
    await _queueWrite(() => _commitChunkedDelete(COLLECTIONS.tardies, ids));
    return true;
  }
  // ---------------------------------------------------------------------------
  // Holidays
  // ---------------------------------------------------------------------------
  function holidays() {
    return _holidays.slice();
  }
  async function addHoliday(holiday) {
    const entry = _normalizeHolidayRecord(holiday);
    if (!entry) return null;
    _holidays.push(entry);
    await _queueWrite(() => _db.collection(COLLECTIONS.holidays).doc(entry.id).set(_stripUndefined({
      ...entry,
      id: undefined,
    })));
    return { ...entry };
  }
  async function removeHoliday(id) {
    const idx = _holidays.findIndex(holiday => holiday.id === id);
    if (idx === -1) return false;
    _holidays.splice(idx, 1);
    await _queueWrite(() => _db.collection(COLLECTIONS.holidays).doc(id).delete());
    return true;
  }
  function isHoliday(dateStr) {
    const date = _toDateStr(dateStr);
    return _holidays.some(holiday => {
      if (holiday.type === 'schoolday') return false; // School Day is not a holiday
      const start = _toDateStr(holiday.startDate || holiday.date);
      const end = _toDateStr(holiday.endDate || holiday.startDate || holiday.date);
      return date >= start && date <= end;
    });
  }
  function isSchoolDay(dateStr) {
    const date = _toDateStr(dateStr);
    return _holidays.some(holiday => {
      if (holiday.type !== 'schoolday') return false;
      const start = _toDateStr(holiday.startDate || holiday.date);
      const end = _toDateStr(holiday.endDate || holiday.startDate || holiday.date);
      return date >= start && date <= end;
    });
  }
  function isWeekend(dateStr) {
    const parsed = _asDate(dateStr);
    if (!parsed) return false;
    const day = parsed.getDay();
    return day === 0 || day === 6;
  }
  function isNonSchoolDay(dateStr) {
    // Weekend that is a designated school day (School Day) is NOT a non-school day
    if (isWeekend(dateStr) && isSchoolDay(dateStr)) return false;
    return isWeekend(dateStr) || isHoliday(dateStr);
  }
  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------
  function getSettings() {
    return _cloneSettings();
  }
  function getDefaultTardyReasonSuggestions() {
    return DEFAULT_TARDY_REASON_SUGGESTIONS.slice();
  }
  async function setSetting(key, value) {
    _settings[key] = value;
    const nextSettings = _cloneSettings();
    const publicSettings = _publicSettingsFrom(nextSettings);
    await _queueWrite(async () => {
      const batch = _db.batch();
      batch.set(_db.collection(COLLECTIONS.settings).doc(SETTINGS_DOC_ID), nextSettings, { merge: true });
      batch.set(_db.collection(COLLECTIONS.publicSettings).doc(SETTINGS_DOC_ID), publicSettings, { merge: true });
      await batch.commit();
    });
    return _cloneSettings();
  }
  async function syncPublicSettings() {
    const publicSettings = _publicSettingsFrom(_cloneSettings());
    await _queueWrite(() => _db.collection(COLLECTIONS.publicSettings).doc(SETTINGS_DOC_ID).set(publicSettings, { merge: true }));
    return publicSettings;
  }
  // ---------------------------------------------------------------------------
  // Signatures
  //   /signatures/{email_lowercase}
  //     dataUrl   : "data:image/png;base64,..."
  //     updatedAt : ISO string
  //     email     : lowercase email
  // ---------------------------------------------------------------------------
  function _normalizeSignatureEmail(email) {
    return String(email || '').trim().toLowerCase();
  }
  async function getSignature(email) {
    const key = _normalizeSignatureEmail(email);
    if (!key || !_db) return null;
    try {
      const snap = await _db.collection(COLLECTIONS.signatures).doc(key).get();
      if (!snap.exists) return null;
      const data = snap.data() || {};
      if (!data.dataUrl) return null;
      return {
        email: key,
        dataUrl: String(data.dataUrl),
        updatedAt: data.updatedAt || '',
      };
    } catch (err) {
      console.error('[AppDB] getSignature failed:', err);
      return null;
    }
  }
  // Authoritative staff check: attempts to read the private /settings/app
  // document. Firestore rules grant read access to that doc only to staff
  // (super admin allowlist + emails in staffEmails), so a successful read
  // is itself proof that the user is staff. Useful as a front-end gate so
  // we can surface a clear message before triggering further reads/writes.
  async function isCurrentUserStaff(email) {
    if (!_db) return false;
    const target = String(email || '').trim().toLowerCase();
    if (!target) return false;
    const superAdmins = (Array.isArray(window.__SUPER_ADMINS__) ? window.__SUPER_ADMINS__ : [])
      .map(e => String(e || '').trim().toLowerCase())
      .filter(Boolean);
    if (superAdmins.includes(target)) return true;
    try {
      const snap = await _db.collection(COLLECTIONS.settings).doc(SETTINGS_DOC_ID).get();
      if (!snap.exists) return false;
      const data = snap.data() || {};
      const staffEmails = Array.isArray(data.staffEmails)
        ? data.staffEmails.map(e => String(e || '').trim().toLowerCase())
        : [];
      return staffEmails.includes(target);
    } catch (err) {
      // permission-denied or other read failure → not staff
      return false;
    }
  }
  async function saveSignature(email, dataUrl) {
    const key = _normalizeSignatureEmail(email);
    if (!key) throw new Error('Email is required to save a signature.');
    if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
      throw new Error('Invalid signature data.');
    }
    if (!_db) throw new Error('Firestore is not connected.');
    const payload = {
      email: key,
      dataUrl: dataUrl,
      updatedAt: new Date().toISOString(),
    };
    await _db.collection(COLLECTIONS.signatures).doc(key).set(payload, { merge: true });
    return payload;
  }
  // ---------------------------------------------------------------------------
  // Period Calculation
  // ---------------------------------------------------------------------------
  function calculatePeriods(startTime, endTime) {
    if (!startTime || !endTime) return 0;
    const start = new Date(startTime);
    const end = new Date(endTime);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return 0;
    const startDate = _toDateStr(start);
    const endDate = _toDateStr(end);
    const cursor = new Date(startDate + 'T00:00:00');
    const last = new Date(endDate + 'T00:00:00');
    let totalPeriods = 0;
    while (cursor <= last) {
      const dayStr = _toDateStr(cursor);
      if (!isNonSchoolDay(dayStr)) { // includes School Day weekends
        let dayStartMinutes = 0;
        let dayEndMinutes = 24 * 60;
        if (dayStr === startDate) {
          dayStartMinutes = start.getHours() * 60 + start.getMinutes();
        }
        if (dayStr === endDate) {
          dayEndMinutes = end.getHours() * 60 + end.getMinutes();
        }
        ACADEMIC_PERIODS.forEach(period => {
          const periodStart = _timeToMinutes(period.start);
          const periodEnd = _timeToMinutes(period.end);
          if (periodStart < dayEndMinutes && periodEnd > dayStartMinutes) {
            totalPeriods++;
          }
        });
      }
      cursor.setDate(cursor.getDate() + 1);
    }
    return totalPeriods;
  }
  // ---------------------------------------------------------------------------
  // Workflow helpers
  // ---------------------------------------------------------------------------
  function leaveDurationDays(leave) {
    const from = _toDateStr(leave.fromDate || leave.startTime);
    const to   = _toDateStr(leave.toDate || leave.endTime || from);
    if (!from || !to) return 0;
    const a = new Date(from + 'T00:00:00');
    const b = new Date(to + 'T00:00:00');
    if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 0;
    return Math.max(1, Math.round((b - a) / (1000 * 60 * 60 * 24)) + 1);
  }
  function isStageApplicable(stage, leave) {
    if (!stage || !stage.condition || !stage.condition.type) return true;
    if (stage.condition.type === 'minDays') {
      return leaveDurationDays(leave) >= (stage.condition.value || 0);
    }
    return true;
  }
  /**
   * Returns the next applicable stage index for a leave, starting at fromIndex.
   * Returns -1 if no further applicable stage (i.e. fully approved).
   */
  function nextApplicableStageIndex(workflow, leave, fromIndex) {
    if (!Array.isArray(workflow)) return -1;
    for (let i = fromIndex; i < workflow.length; i++) {
      if (isStageApplicable(workflow[i], leave)) return i;
    }
    return -1;
  }
  // ---------------------------------------------------------------------------
  // Google Calendar Integration
  // ---------------------------------------------------------------------------
  /**
   * Fetch Taiwan public holidays from Google Calendar API.
   * Uses the public "Taiwan Holidays" calendar.
   * Requires Google Calendar API to be enabled in the Firebase/GCP project.
   *
   * @param {number} [year] - The year to fetch. Defaults to current year.
   * @returns {Promise<Array<{date: string, endDate: string, name: string}>>}
   */
  async function fetchGoogleCalendarHolidays(year) {
    const config = _getFirebaseConfig();
    if (!config || !config.apiKey) {
      throw new Error('Firebase API key is required for Google Calendar integration.');
    }
    const targetYear = year || new Date().getFullYear();
    const calendarId = encodeURIComponent('zh-tw.taiwan#holiday@group.v.calendar.google.com');
    const timeMin = `${targetYear}-01-01T00:00:00Z`;
    const timeMax = `${targetYear}-12-31T23:59:59Z`;
    const url = `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`
      + `?key=${config.apiKey}`
      + `&timeMin=${timeMin}`
      + `&timeMax=${timeMax}`
      + `&singleEvents=true`
      + `&orderBy=startTime`
      + `&maxResults=100`;
    const response = await fetch(url);
    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(`Google Calendar API error (${response.status}): ${errBody}`);
    }
    const data = await response.json();
    const items = data.items || [];
    return items.map(event => {
      // Google Calendar all-day events use date (not dateTime)
      const startDate = event.start.date || (event.start.dateTime || '').slice(0, 10);
      // endDate for all-day events is exclusive (next day), so subtract 1 day
      let endDate = startDate;
      if (event.end && event.end.date) {
        const ed = new Date(event.end.date + 'T00:00:00');
        ed.setDate(ed.getDate() - 1);
        endDate = ed.toISOString().slice(0, 10);
      }
      return {
        date: startDate,
        startDate: startDate,
        endDate: endDate,
        name: event.summary || '',
      };
    }).filter(h => h.date);
  }
  /**
   * Import holidays from Google Calendar into the local holiday list.
   * Skips duplicates (same date + name).
   *
   * @param {number} [year] - The year to fetch.
   * @returns {Promise<{added: number, skipped: number, total: number}>}
   */
  async function importGoogleCalendarHolidays(year) {
    const fetched = await fetchGoogleCalendarHolidays(year);
    const existingKeys = new Set(
      _holidays.map(h => (h.startDate || h.date) + '|' + (h.name || ''))
    );
    let added = 0;
    let skipped = 0;
    for (const h of fetched) {
      const key = h.startDate + '|' + h.name;
      if (existingKeys.has(key)) {
        skipped++;
        continue;
      }
      await addHoliday({
        startDate: h.startDate,
        endDate: h.endDate,
        name: h.name,
        type: 'google-calendar',
      });
      existingKeys.add(key);
      added++;
    }
    return { added, skipped, total: _holidays.length };
  }
  // ---------------------------------------------------------------------------
  // Export helpers
  // ---------------------------------------------------------------------------
  function exportLeaves(from, to) {
    return getLeavesByDateRange(from, to).map(leaveRecord => ({
      id: leaveRecord.id,
      studentNo: leaveRecord.studentNo,
      className: leaveRecord.className,
      seatNo: leaveRecord.seatNo,
      chineseName: leaveRecord.chineseName,
      englishName: leaveRecord.englishName,
      leaveType: leaveRecord.leaveType,
      startTime: leaveRecord.startTime,
      endTime: leaveRecord.endTime,
      periods: leaveRecord.periods,
      reason: leaveRecord.reason,
      status: leaveRecord.status,
      createdAt: leaveRecord.createdAt,
    }));
  }
  function exportTardies(from, to) {
    return getTardiesByDateRange(from, to).map(tardyRecord => ({
      id: tardyRecord.id,
      studentNo: tardyRecord.studentNo,
      className: tardyRecord.className,
      seatNo: tardyRecord.seatNo,
      chineseName: tardyRecord.chineseName,
      englishName: tardyRecord.englishName,
      reason: tardyRecord.reason,
      date: tardyRecord.date,
      createdAt: tardyRecord.createdAt,
    }));
  }
  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------
  window.AppDB = {
    PERIODS,
    GRADE_ADVANCE_MAX_STUDENTS,
    // Lifecycle
    init,
    initForAdmin,
    initForPortal,
    initForTardy,
    status,
    // Students
    students,
    addStudent,
    updateStudent,
    removeStudent,
    advanceStudentGrades,
    importStudents,
    syncAllPublicStudents,
    getStudentsByClass,
    getStudentByNo,
    getStudentByEmail,
    getStudentsByParentEmail,
    getStaffByEmail,
    getClassList,
    compareClassNames: _compareClassNames,
    // Workflow
    leaveDurationDays,
    isStageApplicable,
    nextApplicableStageIndex,
    // Leaves
    leave,
    addLeave,
    updateLeave,
    updateLeaveTransaction,
    removeLeave,
    getLeavesByDate,
    getLeavesByDateRange,
    getPendingLeaves,
    getLeavesByStudentNo,
    // Tardies
    tardies,
    addTardy,
    getTardiesByDate,
    getTardiesByDateRange,
    getTardiesByStudentNo,
    clearTardies,
    // Holidays
    holidays,
    addHoliday,
    removeHoliday,
    isHoliday,
    isSchoolDay,
    isWeekend,
    isNonSchoolDay,
    // Settings
    getSettings,
    setSetting,
    syncPublicSettings,
    getDefaultTardyReasonSuggestions,
    // Signatures
    getSignature,
    saveSignature,
    // Role check
    isCurrentUserStaff,
    // Calculations
    calculatePeriods,
    // Google Calendar
    fetchGoogleCalendarHolidays,
    importGoogleCalendarHolidays,
    // Export
    exportLeaves,
    exportTardies,
  };
})();
