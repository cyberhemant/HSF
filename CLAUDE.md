# CLAUDE.md

## Component reuse

Before creating any new component or variant, check [src/components/](src/components/) and the [design-system page](src/pages/design-system/index.astro) for something that already covers the need. Extend an existing component (new prop/variant) over creating a new file. If nothing fits, say so and propose the new component before building it, rather than creating it silently.

### Container context

Before designing any new component or variant, ask whether it will be used inside a Bootstrap modal or offcanvas, rather than assuming the page background. Both are their own stacking context and can scroll or clip their content (`.modal` itself scrolls via `overflow-y: auto`; `.modal-dialog-scrollable` additionally gives `.modal-content` `overflow: hidden`). A component whose own panel escapes its box — a dropdown, a popover, a full-screen sheet — needs its positioning and z-index reasoned about against that container up front, not discovered later. If the answer is yes, check it against the [Component Testing](src/pages/design-system/component-testing.astro) page's modal scenarios (or add one) before calling it done.

### Decision order

Walk these top to bottom and stop at the first yes:

1. An existing component already does it → use it.
2. Same thing, different content → props or slots.
3. Same thing, different size, emphasis or context → add a size or variant.
4. Same thing in a temporary data or interaction condition (loading, empty, error, disabled) → add a state.
5. Buildable by arranging existing components, with no new behaviour or markup contract → compose, and document it as a pattern.
6. Needs new behaviour, semantics or structure that would worsen an existing component's API → new component.

Tie-breakers: same job means same component; a variant that changes structure (not just colour or size) is a sign of two components; don't extract a shared component from a single use unless it is obviously generic (e.g. an empty state).

A proposal for a new component states: the need, which existing components were considered and why each fails, and which existing components/tokens it reuses.

### State audit

Decide yes / no / n.a. for each state (default, hover, focus, active, disabled, loading, skeleton, empty, error, success) and note the reason for every "no". Build only the "yes" states.

- Interaction components (button, input, tab): interaction states, plus validation if they take input. Focus is always required.
- Data components (gallery, listing, table, search results): one shared enum, `state = 'ready' | 'loading' | 'empty' | 'error'`. Use an enum, never `isLoading` / `isEmpty` booleans.
- Skeleton is for content with a known layout; a spinner ([PalmSpinner](src/components/PalmSpinner.astro)) is for actions or content with no shape. The parent owns its skeleton layout; the shared `.placeholder` primitive owns the skeleton style.

### Every component must (merge gate)

- Use semantic HTML, have an accessible name, be keyboard operable, and show visible focus.
- Use tokens only: no raw hex, one-off px spacing or ad-hoc font sizes.
- State its responsive behaviour (what changes at the `md` breakpoint, or "does not change").
- Handle long, missing and empty content.
- Respect `prefers-reduced-motion` if it animates.
- Keep a minimal props API: enums over booleans, names consistent with sibling components, defaults so the simple case is one line.
- Have a design-system page entry with a live example of each variant and state.

When applicable: keyboard spec for composite widgets, 44px touch targets and no hover-only information, icons from the existing [Icon](src/components/Icon.astro), motion from tokens, lazy-loading and image dimensions to prevent layout shift. For shared components: usage guidance, do/don't examples, and a Figma component whose property names match the code props.

### Status and change control

Label components experimental (one use), beta (2+ uses, merge gate met) or stable (merge gate and applicable items met). Additive changes (new optional prop or variant) are safe; renames and removals are breaking and need a deprecation note naming the replacement.

### Colour source of truth

Every colour comes from the design-system variables in [main.scss](src/styles/main.scss) (or their `--bs-*` / utility-class equivalents, e.g. `bg-cream`). When given a colour (hex or description), map it to an existing variable. Never hard-code hex, `rgb()`/`rgba()` literals or named colours (`white`, `black`) in SCSS, `<style>` blocks or inline styles. If no variable matches, ask before adding a new one; do not add it silently. Alpha is fine when applied to a token (`rgba($maroon, .1)`).

### Dark mode readiness

Dark mode is not a current requirement, so do not build it. Do keep it cheap to add later:

- Components reference semantic roles (surface, text, text-muted, border, accent, skeleton, focus-ring), not palette colours like maroon or sand.
- Role colours are emitted as CSS custom properties (Bootstrap 5.3 `--bs-*` vars), not SCSS variables, which are resolved at build time and cannot change with a theme. Existing SCSS-variable usages can be migrated when convenient.
- Use `currentColor` for SVG icons, and never rely on colour alone to carry meaning.
- If a component needs its own dark override, the semantic layer is missing a role. Add the role instead.
