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
