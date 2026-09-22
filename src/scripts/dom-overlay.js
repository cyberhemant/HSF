// Shared helpers for fullscreen overlays (Autocomplete's mobile search, the
// lodge date picker's sheet).

// Document-level scroll lock, reference-counted so two overlays can't unlock
// each other. `.scroll-lock` is defined in main.scss.
let scrollLocks = 0;
export const lockScroll = () => {
  if (scrollLocks++ === 0) document.documentElement.classList.add('scroll-lock');
};
export const unlockScroll = () => {
  if (--scrollLocks === 0) document.documentElement.classList.remove('scroll-lock');
};

// Makes everything outside `el` inert (unreachable by pointer, keyboard and
// screen reader) and returns the function that undoes exactly that. Toast
// containers are left alone: a toast is a live status (and may carry a Retry
// action) that has to stay usable above an open overlay.
export const inertOutside = (el) => {
  const changed = [];
  for (let node = el; node.parentElement; node = node.parentElement) {
    for (const sibling of node.parentElement.children) {
      if (sibling !== node && !sibling.inert && !sibling.classList.contains('toast-container')) {
        sibling.inert = true;
        changed.push(sibling);
      }
    }
  }
  return () => changed.forEach((s) => { s.inert = false; });
};
