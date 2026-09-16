import { defineConfig } from 'astro/config';

// Deployed to both GitHub Pages and Netlify. Pages serves project sites
// under /<repo-name>/, so every link and asset path in the app is built
// with `base` baked in — but Netlify serves from the domain root, so that
// same prefix 404s there. Netlify sets NETLIFY=true and URL (the site's
// live URL) during its own builds; GitHub Actions doesn't, so this falls
// back to the Pages config whenever it's not building on Netlify.
// TODO: replace 'your-username' below with your GitHub username before the first Pages push.
const isNetlify = Boolean(process.env.NETLIFY);

export default defineConfig({
  site: isNetlify ? process.env.URL : 'https://your-username.github.io',
  base: isNetlify ? '/' : '/heenat-prototype',
  build: {
    format: 'directory',
  },
  vite: {
    css: {
      preprocessorOptions: {
        // Bootstrap's own Sass still uses pre-module color functions;
        // quietDeps silences warnings from node_modules, not our own code.
        scss: {
          quietDeps: true,
          silenceDeprecations: ['color-functions', 'import', 'global-builtin'],
        },
      },
    },
  },
});
