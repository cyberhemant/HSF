// Bootstrap's data-bs-* attribute API auto-initializes most components
// (offcanvas, dropdown, collapse, modal) once this bundle is loaded — no
// per-instance JS needed. Tooltips and popovers are the documented exception:
// they must be enabled explicitly for performance reasons.
import * as bootstrap from 'bootstrap';

document.querySelectorAll('[data-bs-toggle="tooltip"]').forEach((el) => new bootstrap.Tooltip(el));
document.querySelectorAll('[data-bs-toggle="popover"]').forEach((el) => new bootstrap.Popover(el));

// Toasts have no data-attribute trigger to open them (only to dismiss) —
// this is Bootstrap's own documented pattern for showing one on demand.
const toastTrigger = document.getElementById('ds-toast-trigger');
const toastEl = document.getElementById('ds-toast');
if (toastTrigger && toastEl) {
  toastTrigger.addEventListener('click', () => {
    bootstrap.Toast.getOrCreateInstance(toastEl).show();
  });
}

// Underline Tabs demo — the sliding bar has no data-attribute equivalent, so
// it's measured off the active <li> here: once on load, then again on every
// shown.bs.tab event so it animates to the newly active tab (transition
// lives on .tabs-underline__bar in main.scss). Re-measured on resize too,
// since the tab labels' widths depend on layout.
const underlineNav = document.getElementById('ds-utab');
const underlineBar = underlineNav?.querySelector('.tabs-underline__bar');
if (underlineNav && underlineBar) {
  const moveBarToLink = (link) => {
    const li = link.closest('.nav-item');
    if (!li) return;
    const navRect = underlineNav.getBoundingClientRect();
    const liRect = li.getBoundingClientRect();
    underlineBar.style.width = `${liRect.width}px`;
    underlineBar.style.transform = `translateX(${liRect.left - navRect.left}px)`;
  };

  const activeLink = underlineNav.querySelector('.nav-link.active');
  if (activeLink) moveBarToLink(activeLink);

  underlineNav.querySelectorAll('[data-bs-toggle="tab"]').forEach((trigger) => {
    trigger.addEventListener('shown.bs.tab', (e) => moveBarToLink(e.target));
  });

  window.addEventListener('resize', () => {
    const current = underlineNav.querySelector('.nav-link.active');
    if (current) moveBarToLink(current);
  });
}
