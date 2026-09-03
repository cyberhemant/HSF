# Heenat Salma Farm — Prototype

Static, component-based responsive prototype of the Heenat Salma Farm home page.
Astro + SCSS + vanilla JS. No CSS framework, no client-side runtime, no server.

## Run

```bash
npm install
npm run dev       # localhost:4321
npm run build     # → dist/
npm run preview   # serve dist/ exactly as GitHub Pages will
```

Always `npm run preview` before pushing — it is the only local check that catches
`base` path mistakes.

## Routes

| Route | What it is |
|-------|-----------|
| `/` | Version picker — **this is the link to send the client** |
| `/styleguide/` | Palette with contrast ratios, type ramp, components in every state |
| `/v1/` | Design direction 1 |
| `/v2/` | Design direction 2 |

## Rules

- **No hex values outside `src/styles/foundation/_tokens.scss`.**
- Body copy is `--ink-soft`; headings are `--ink`. Never full maroon for body.
- Ochre is never text below 18px — it fails AA at 3.1:1 on cream. Use `--ochre-deep`.
- Mobile-first, `min-width` only.
- Logical properties (`margin-inline`, `padding-block`) throughout, so RTL stays a
  `dir` attribute rather than a rewrite.
- Components are shared across versions; **compositions fork**. A version is a
  theme file plus a page composition. If you need to edit a component's SCSS to
  make a version work, the component is missing a `variant` prop.

Design source of truth: `../DESIGN.md`. Setup rationale: `../SETUP.md`.
Build sequence: `../BUILD-PLAN.md`.
