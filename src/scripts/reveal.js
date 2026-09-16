// Scroll-reveal for elements marked `.reveal` — fades/rises into view once.
// Reduced motion is handled entirely in CSS (main.scss), not here. Fails
// open: if IntersectionObserver is unavailable, everything reveals
// immediately rather than staying hidden.
const targets = document.querySelectorAll('.reveal');

if ('IntersectionObserver' in window) {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.15, rootMargin: '0px 0px -10% 0px' });

  targets.forEach((el) => observer.observe(el));
} else {
  targets.forEach((el) => el.classList.add('is-visible'));
}
