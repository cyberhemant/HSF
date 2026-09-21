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
//   onClose     Called once, after the toast has fully closed
//
// Returns { id, element, hide } — `hide()` closes it programmatically (the only
// way to close a toast that is neither auto-hiding nor dismissible) — or null
// if `body` is missing.
import { Toast } from 'bootstrap';

const DEFAULTS = {
  theme: 'info',
  position: 'top-center',
  autoHide: true,
  duration: 3000,
  dismissible: true,
  linkTarget: '_self',
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
    onClose,
  } = options;

  if (typeof body !== 'string' || !body.trim()) {
    console.warn('showToast: `body` is required.');
    return null;
  }

  const themeKey = Object.hasOwn(THEMES, theme) ? theme : DEFAULTS.theme;
  const { color, icon: themeIcon } = THEMES[themeKey];
  const positionKey = Object.hasOwn(POSITIONS, position) ? position : DEFAULTS.position;
  const delay = Number.isFinite(duration) && duration > 0 ? duration : DEFAULTS.duration;
  const target = linkTarget === '_blank' ? '_blank' : DEFAULTS.linkTarget;
  const toastId = uniqueId(id);

  const toastEl = create(
    'div',
    `toast shadow-lg bg-body border-0 border-start border-5 border-${color}`,
    { id: toastId, role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' },
  );
  const row = create('div', 'd-flex align-items-center');
  const message = create('div', `flex-grow-1 text-break ms-2 ${dismissible ? 'me-2' : ''}`.trim());
  message.append(body);
  const link = buildLink(linkLabel, linkUrl, target);
  if (link) message.append(link);

  row.append(buildIcon(icon || themeIcon, `text-${color}`), message);
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
  // callbacks never cross between toasts. `hidden.bs.toast` fires after the
  // fade-out finishes, for both timeout and manual close.
  const instance = new Toast(toastEl, { autohide: autoHide, delay });
  toastEl.addEventListener('hidden.bs.toast', () => {
    instance.dispose();
    toastEl.remove();
    if (typeof onClose === 'function') onClose();
  }, { once: true });
  instance.show();

  return { id: toastId, element: toastEl, hide: () => instance.hide() };
}
