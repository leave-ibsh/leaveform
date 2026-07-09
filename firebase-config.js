(function () {
  'use strict';

  window.__FIREBASE_CONFIG__ = {
    apiKey: 'AIzaSyDOoAP5fNTGDHtqPSS8jWWoNMyvLTqk1B4',
    authDomain: 'tardy-and-leave.firebaseapp.com',
    projectId: 'tardy-and-leave',
    storageBucket: 'tardy-and-leave.firebasestorage.app',
    messagingSenderId: '940807032024',
    appId: '1:940807032024:web:17f588917d4f30744d9bad',
    measurementId: 'G-BBERTFPHLN',
  };

  // Super-admin allowlist – these accounts can ALWAYS access admin.html,
  // regardless of /settings/app.staffUsers state.
  //
  // !!! CRITICAL: this list MUST stay in sync with the `isSuperAdmin()`
  // function in firestore.rules. Editing only one side will either lock
  // a real super admin out (front-end allows, rules deny) or grant an
  // un-listed account silent access to admin.html UI (rules deny writes
  // but the page still renders). Update both files in the same commit
  // and re-deploy `firebase deploy --only firestore:rules,hosting`.
  window.__SUPER_ADMINS__ = [
    'leave@ibsh.tw',
  ];
})();
