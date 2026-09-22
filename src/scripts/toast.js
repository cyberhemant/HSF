// Themed toast — imperative wrapper over Bootstrap's own Toast. Toasts are
// created on demand (a booking sent, a form saved), can carry an `onClose`
// callback and stack in a shared container, none of which a build-time Astro
// component can do. Bootstrap still owns everything it already does well:
// the show/hide transition, the auto-hide timer (which pauses while the toast
// is hovered or focused), and the close button (data-bs-dismiss="toast", a
// delegated handler that works on toasts added after page load).
//
//   import { showToast } from '../scripts/toast.js';
//   showToast({ body: 'Your booking request was sent.', theme: 'success' });
//
// Options (only `body` is required):
//   id          Unique DOM id. Generated when omitted or already in use.
//   body        Message text. Set via textContent — never parsed as HTML.
//   theme       'info' | 'success' | 'warning' | 'error'      (info)
//   icon        Material Symbols name; overrides the theme's icon
//   position    'top-start' | 'top-center' | 'top-end' |
//               'bottom-start' | 'bottom-center' | 'bottom-end'  (top-center)
//   autoHide    Close after `duration` ms                       (true)
//   duration    Milliseconds before auto-hide                   (3000)
//   dismissible Render the close button                         (true)
//   linkLabel, linkUrl   Optional link; rendered only when both are given
//   linkTarget  '_self' | '_blank'                              (_self)
//   action      { label, onClick } — a button beside the message, for a
//               follow-up the guest can run right there (e.g. Retry). Clicking
//               it calls onClick, then closes the toast. Both need a value or
//               the button is omitted. Can be combined with a link.
//   dedupe      A repeat call matching an already-open (or still-queued)
//               toast bumps that one instead of stacking a duplicate — the
//               common case is a flaky retry firing the same error twice.
//               Set false to always stack.                        (true)
//   dedupeKey   What "the same toast" means. Defaults to `${theme}::${body}`;
//               pass one explicitly if two calls with different text should
//               still count as duplicates.
//   onClose     Called once, after the toast has fully closed
//
// At most MAX_VISIBLE_PER_POSITION toasts are shown at once per position;
// a burst of further calls queues and appears as earlier ones close, rather
// than stacking the whole screen.
//
// Returns { id, element, hide } — `hide()` closes it programmatically (the
// only way to close a toast that is neither auto-hiding nor dismissible),
// cancels it if it's still queued and never shown, or is a no-op if it's
// already closed/closing — or null if `body` is missing.
import { Toast } from 'bootstrap';

const DEFAULTS = {
  theme: 'info',
  position: 'top-center',
  autoHide: true,
  duration: 3000,
  dismissible: true,
  linkTarget: '_self',
  dedupe: true,
};

// `color` is the Bootstrap theme colour: error is "danger" in Bootstrap.
const THEMES = {
  info: { color: 'info', icon: 'chat_info' },
  success: { color: 'success', icon: 'task_alt' },
  warning: { color: 'warning', icon: 'warning' },
  error: { color: 'danger', icon: 'error' },
};

// Top positions sit below the fixed header: mt-7 (64px) plus the container's
// p-3 clears it.
const POSITIONS = {
  'top-start': 'top-0 start-0 mt-7',
  'top-center': 'top-0 start-50 translate-middle-x mt-7',
  'top-end': 'top-0 end-0 mt-7',
  'bottom-start': 'bottom-0 start-0',
  'bottom-center': 'bottom-0 start-50 translate-middle-x',
  'bottom-end': 'bottom-0 end-0',
};

const ICON_SIZE = 36;
const SAFE_LINK_PROTOCOLS = ['http:', 'https:', 'mailto:', 'tel:'];

// At most this many toasts are visible per position at once; the rest wait
// in `queues` and get shown as earlier ones close (see presentNext below).
const MAX_VISIBLE_PER_POSITION = 3;
const visibleCounts = new Map(); // position -> number currently shown
const queues = new Map(); // position -> [{ instance, status }], oldest first
const activeByDedupeKey = new Map(); // dedupeKey -> { handle, instance, status }

let sequence = 0;

const create = (tag, className, attrs = {}) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  Object.entries(attrs).forEach(([name, value]) => node.setAttribute(name, value));
  return node;
};

const uniqueId = (requested) => {
  if (requested && !document.getElementById(requested)) return requested;
  if (requested) console.warn(`showToast: id "${requested}" is already in use; generated one instead.`);
  let id;
  do id = `toast-${++sequence}`;
  while (document.getElementById(id));
  return id;
};

// One container per position; toasts inside stack via Bootstrap's own
// .toast-container spacing.
const getContainer = (position) => {
  const id = `toast-container-${position}`;
  let container = document.getElementById(id);
  if (!container) {
    container = create('div', `toast-container position-fixed p-3 ${POSITIONS[position]}`, { id });
    document.body.append(container);
  }
  return container;
};

// Only http(s), mailto and tel links: a `javascript:` URL is script execution.
const isSafeUrl = (url) => {
  try {
    return SAFE_LINK_PROTOCOLS.includes(new URL(url, window.location.href).protocol);
  } catch {
    return false;
  }
};

const buildAction = (action) => {
  const label = typeof action?.label === 'string' ? action.label.trim() : '';
  if (!label || typeof action.onClick !== 'function') {
    if (action) console.warn('showToast: action omitted, it needs a `label` and an `onClick` function.');
    return null;
  }
  const button = create('button', 'btn btn-sm btn-outline-secondary flex-shrink-0 me-2', { type: 'button' });
  button.textContent = label;
  return button;
};

const buildLink = (label, url, target) => {
  const text = typeof label === 'string' ? label.trim() : '';
  const href = typeof url === 'string' ? url.trim() : '';
  if (!text || !href) return null;
  if (!isSafeUrl(href)) {
    console.warn(`showToast: link omitted, "${href}" is not an http(s), mailto or tel URL.`);
    return null;
  }
  const link = create('a', 'ms-1', { href });
  link.textContent = text;
  if (target === '_blank') {
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
  }
  return link;
};

// Same markup as Icon.astro (which can't run at runtime).
const buildIcon = (name, colorClass) => {
  const icon = create('span', `material-symbols-outlined flex-shrink-0 ${colorClass}`, { 'aria-hidden': 'true' });
  icon.style.setProperty('--icon-size', `${ICON_SIZE}px`);
  icon.style.fontVariationSettings = `'FILL' 0, 'wght' 300, 'GRAD' 0, 'opsz' ${ICON_SIZE}`;
  icon.textContent = name.replace(/-/g, '_');
  return icon;
};

// Shows the next queued toast for a position, called whenever a visible one
// finishes closing and frees up a slot.
const presentNext = (positionKey) => {
  const next = queues.get(positionKey)?.shift();
  if (!next) return;
  visibleCounts.set(positionKey, (visibleCounts.get(positionKey) ?? 0) + 1);
  next.status.state = 'visible';
  next.instance.show();
};

export function showToast(options = {}) {
  const {
    id,
    body,
    theme,
    icon,
    position,
    autoHide = DEFAULTS.autoHide,
    duration,
    dismissible = DEFAULTS.dismissible,
    linkLabel,
    linkUrl,
    linkTarget,
    action,
    dedupe = DEFAULTS.dedupe,
    dedupeKey,
    onClose,
  } = options;

  if (typeof body !== 'string' || !body.trim()) {
    console.warn('showToast: `body` is required.');
    return null;
  }

  const themeKey = Object.hasOwn(THEMES, theme) ? theme : DEFAULTS.theme;
  const { color, icon: themeIcon } = THEMES[themeKey];

  const key = dedupe ? (dedupeKey ?? `${themeKey}::${body}`) : null;
  const existing = key ? activeByDedupeKey.get(key) : null;
  if (existing) {
    // Visible: bump the auto-hide timer. Still queued: nothing to bump yet —
    // the call is simply absorbed into the one already waiting its turn.
    if (existing.status.state === 'visible') existing.instance.show();
    return existing.handle;
  }

  const positionKey = Object.hasOwn(POSITIONS, position) ? position : DEFAULTS.position;
  const delay = Number.isFinite(duration) && duration > 0 ? duration : DEFAULTS.duration;
  const target = linkTarget === '_blank' ? '_blank' : DEFAULTS.linkTarget;
  const toastId = uniqueId(id);

  const toastEl = create(
    'div',
    `toast shadow-lg bg-white border-0 border-start border-5 border-${color}`,
    { id: toastId, role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' },
  );
  const row = create('div', 'd-flex align-items-center');
  const message = create('div', `flex-grow-1 text-break ms-2 ${dismissible ? 'me-2' : ''}`.trim());
  message.append(body);
  const link = buildLink(linkLabel, linkUrl, target);
  if (link) message.append(link);

  const actionButton = buildAction(action);
  row.append(buildIcon(icon || themeIcon, `text-${color}`), message);
  if (actionButton) row.append(actionButton);
  if (dismissible) {
    row.append(create('button', 'btn-close flex-shrink-0', {
      type: 'button',
      'data-bs-dismiss': 'toast',
      'aria-label': 'Close',
    }));
  }
  const toastBody = create('div', 'toast-body');
  toastBody.append(row);
  toastEl.append(toastBody);
  getContainer(positionKey).append(toastEl);

  // Each toast gets its own Bootstrap instance, so timers, dismissal and
  // callbacks never cross between toasts. A toast created over the visible
  // cap stays in the DOM (Bootstrap's own `.toast:not(.show)` keeps it
  // invisible) until presentNext() calls show() on it later.
  const instance = new Toast(toastEl, { autohide: autoHide, delay });
  const status = { state: 'queued' }; // 'queued' | 'visible' | 'closed'
  const queueEntry = { instance, status };

  const teardown = () => {
    instance.dispose();
    toastEl.remove();
    activeByDedupeKey.delete(key);
    if (typeof onClose === 'function') onClose();
  };

  // `hidden.bs.toast` fires after the fade-out finishes, for both timeout
  // and manual close — but only for a toast that actually got shown; one
  // still sitting in the queue never reaches Bootstrap at all, so hide()
  // below tears it down directly instead of relying on this event.
  toastEl.addEventListener('hidden.bs.toast', () => {
    teardown();
    status.state = 'closed';
    visibleCounts.set(positionKey, visibleCounts.get(positionKey) - 1);
    presentNext(positionKey);
  }, { once: true });

  // hide() is safe to call more than once, and after the toast has closed:
  // Bootstrap queues a callback per call, and the second one would run against
  // a disposed toast. `hide.bs.toast` fires for every route (timer, close
  // button, this function), so it marks the toast as closing.
  let closing = false;
  toastEl.addEventListener('hide.bs.toast', () => { closing = true; });
  const hide = () => {
    if (status.state === 'queued') {
      const queue = queues.get(positionKey);
      const idx = queue ? queue.indexOf(queueEntry) : -1;
      if (idx !== -1) queue.splice(idx, 1);
      status.state = 'closed';
      teardown();
    } else if (status.state === 'visible' && !closing) {
      instance.hide();
    }
  };

  // The action runs first; a throwing handler must not leave the toast stuck.
  actionButton?.addEventListener('click', () => {
    try {
      action.onClick();
    } finally {
      hide();
    }
  });

  const handle = { id: toastId, element: toastEl, hide };
  if (key) activeByDedupeKey.set(key, { handle, instance, status });

  const count = visibleCounts.get(positionKey) ?? 0;
  if (count < MAX_VISIBLE_PER_POSITION) {
    visibleCounts.set(positionKey, count + 1);
    status.state = 'visible';
    instance.show();
  } else {
    if (!queues.has(positionKey)) queues.set(positionKey, []);
    queues.get(positionKey).push(queueEntry);
  }

  return handle;
}
