import { defineConfig } from 'astro/config';

// GitHub Pages configuration.
// TODO: replace 'your-username' below with your GitHub username before the first push.
// `base` must match the repository name exactly, or every asset 404s on Pages.
export default defineConfig({
  site: 'https://your-username.github.io',
  base: '/heenat-prototype',
  build: {
    format: 'directory',
  },
});
