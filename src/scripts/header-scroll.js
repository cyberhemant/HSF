// Toggles `.toggle-menu-style` on the header once the page scrolls past
// 150px, so the header can switch appearance (e.g. background/shadow) on
// scroll. Uses a scroll listener guarded by requestAnimationFrame to avoid
// running the check more than once per frame.
const header = document.querySelector('.h-nav');
const SCROLL_THRESHOLD = 150;

if (header) {
  let ticking = false;

  const updateHeaderState = () => {
    header.classList.toggle('toggle-menu-style', window.scrollY > SCROLL_THRESHOLD);
    ticking = false;
  };

  window.addEventListener('scroll', () => {
    if (!ticking) {
      requestAnimationFrame(updateHeaderState);
      ticking = true;
    }
  }, { passive: true });

  updateHeaderState();
}
