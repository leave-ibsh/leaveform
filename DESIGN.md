# IBSH Leave Portal Design System

This file is the product-specific source of truth for `index.html` and `admin.html`. It takes precedence over generic UI templates.

## Product Character

- Formal enough for a school record system.
- Calm, direct, and easy to scan during repeated daily use.
- Translucent surfaces may create depth, but content and status must stay crisp.
- Motion explains a state change or spatial relationship. It is never decoration that competes with work.

## Shared Principles

1. Show the current task before secondary information.
2. Use plain English by default. Traditional Chinese is available from the top-right language control.
3. Keep approval states explicit: Pending, Approved, Disagreed, Reconciled, or Truancy.
4. Never rely on color alone. Pair status color with a label and, where useful, an icon.
5. Use one responsive document for mobile and desktop. Do not branch on device model or user agent.
6. Keep controls at least 44 by 44 CSS pixels on touch screens.
7. Preserve safe-area padding around fixed mobile controls.

## Visual Tokens

### Family Portal

- Primary ink: `#0f172a`
- Muted text: `#64748b`
- Primary green: `#10b981`
- Dark green: `#047857`
- Soft green: `#d1fae5`
- Attention orange: `#ea580c`
- Attention background: `#ffedd5`
- Glass surface: white at 76-90 percent opacity
- Radius: 8px for cards and controls

### Admin Console

- Base background: `#f8f8f8`
- Primary text: `#111111`
- Secondary text: black at 62 percent opacity
- Primary action: `#222222`
- Success: `#16815f`
- Warning: `#f59e0b`
- Error: `#ef4444`
- Glass surface: white at 76-96 percent opacity
- Radius: 12-22px for working surfaces; 32px only for major dialogs

### Type

- Stack: `Inter Tight`, `Inter`, `Segoe UI`, system sans-serif.
- Body text: 14-16px desktop, at least 14px mobile.
- Compact labels: 11-12px only when paired with a larger value.
- Do not use viewport-width scaling for body text.
- Letter spacing is zero except compact uppercase kickers and status labels.

## Layout

### Family Portal

- Mobile: app bar, independently scrolling content region, fixed four-item bottom navigation.
- Desktop: compact sidebar, full-width work area, approval workflow visible beside request content.
- The active student and action-required message remain near the top.
- A family with multiple children uses a visible student switcher; do not hide this in account settings.

### Admin Console

- Desktop: icon sidebar, sticky top bar, role-specific dashboard.
- Mobile: fixed bottom navigation with columns calculated from visible role-permitted tabs.
- Super admin: settings and student data management.
- Admin: attendance operations, walk-in leave, PowerSchool cross-check, and make-up reconciliation; no Focus Mode.
- Reviewers: approval queue and role-appropriate statistics only.
- Never expose a hidden route only through CSS; permission checks must also run in JavaScript and Firestore rules.

## Components

### Glass Surface

- Use a translucent white or dark surface with a real border.
- Blur is secondary to contrast; text must pass WCAG AA.
- Avoid stacked cards inside cards.

### Status

- Pending: amber/orange plus text.
- Approved/completed: green plus text or check.
- Disagreed/error: red plus text or cross.
- Informational: blue plus text.

### Dialog

- `role="dialog"`, `aria-modal="true"`, and an accessible heading are required.
- Move focus into the dialog, trap Tab navigation, support Escape, and return focus when closed.
- High-risk actions show an impact preview and require explicit confirmation.

### Navigation

- Icon-only desktop navigation always has a tooltip and accessible label.
- Mobile tabs use `role="tab"`, `aria-selected`, arrow-key support, and safe-area padding.
- Active controls may move or scale subtly but must not change layout dimensions.

## Motion

- Fast feedback: 140ms.
- Standard transitions: 240ms.
- Larger sheet/dialog entrance: 420ms maximum.
- Preferred easing: `cubic-bezier(0.16, 1, 0.3, 1)`.
- Animate status changes, tab selection, dialog entrance, and updated metric values.
- Do not use a perpetual marquee for operational data. A live event strip may advance only when new data arrives and must be pausable.
- Honor `prefers-reduced-motion: reduce` by removing nonessential transitions and repeated animation.

## Responsive Rules

- Use `min()`, `max()`, `clamp()`, grid, and flex layouts.
- Use `100svh` and `100dvh` for full-height mobile shells.
- Fixed bottom controls include `env(safe-area-inset-bottom)`.
- Content scrolls inside the app shell; the bottom navigation does not participate in document flow.
- Verify at 390x844, 402x874, 430x932, and 440x956 plus desktop widths.

## Content Rules

- Buttons use verbs: Approve and Sign, Disagree, Print, Apply grade advancement.
- Avoid ambiguous workflow labels such as Done or Processed.
- Display dates in an unambiguous school format and keep source data in ISO `YYYY-MM-DD`.
- Empty states explain the next useful action without marketing language.

## Engineering Guardrails

- Keep the existing Firebase and Firestore permission boundaries.
- Student grade advancement must be previewed, version checked, and committed atomically for the private roster.
- Do not mutate local state before a critical Firestore write succeeds.
- Dynamic notifications use ARIA live regions.
- New UI states require desktop, mobile, keyboard, and reduced-motion verification.
