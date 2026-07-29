/**
 * The app's own theme: neutral, plus the handful of surface decisions that make
 * the sidebar read as a lit, floating pill panel on a flat near-black window.
 *
 * The surface contract, in one line: the *panel* carries the gradient and the
 * *window* is flat. The panel's wash starts at the surface colour and resolves
 * to exactly the window colour at its foot, so its head lifts and its foot
 * dissolves. Nothing else in the app paints a gradient.
 *
 * Why a theme and not CSS. The shell owns geometry (insets, widths, drag
 * regions); everything *visual* — radius, border, shadow, surface colour, the
 * window gradient — belongs to the design system's token pipeline, which is the
 * only place that can express a value once and have it resolve correctly in
 * both colour modes. `defineTheme` with `extends` inherits every neutral token
 * and component rule, so what is written below is only the delta.
 *
 * Note on `extends: neutralTheme`. The base is the *built* neutral theme, whose
 * pre-compiled `theme.css` is scoped to `[data-astryx-theme="neutral"]`. Once
 * `<Theme>` writes `invoiceapp` instead, that stylesheet no longer matches —
 * which is fine, and the reason `extends` is not optional here: it copies
 * neutral's resolved tokens and component rules into this theme, and the
 * runtime `<style>` injection re-emits them under the new scope.
 */

import { defineTheme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';

/**
 * Panel corner. The reference reads ~18px on a 264px panel, which is 1.5 steps
 * of the container radius. Multiplying the token keeps the panel tied to the
 * theme's radius scale — bump the scale and the panel follows — where a bare
 * `18px` would drift the moment the scale changes. The global scale itself is
 * deliberately untouched: raising it would also round every Card and the page
 * container, which the reference does not do.
 */
const PANEL_RADIUS = 'calc(var(--radius-container) * 1.5)';

/**
 * The panel's own wash — the one gradient in the app.
 *
 * Vertical, top to bottom, from `--color-background-surface` to
 * `--color-background-body`. Both are `light-dark()` pairs, so the direction is
 * mode-correct by construction rather than by a mix that happens to work: dark
 * mode runs #262626 -> the near-black body, light mode runs #ffffff -> the grey
 * body. Either way the head of the panel is the lifted surface and its foot is
 * *exactly* the window colour, so the bottom edge dissolves into the backdrop
 * instead of ending in a line.
 *
 * The middle stop is not decoration. A two-stop ramp spends most of its length
 * in the middle greys and the top never reads as a surface; holding a
 * surface-weighted mix until 55% keeps the lifted half lifted and puts the whole
 * fade in the bottom half, which is what the reference does.
 */
const PANEL_GRADIENT = [
  'linear-gradient(180deg,',
  'var(--color-background-surface) 0%,',
  'color-mix(in srgb, var(--color-background-surface) 55%, var(--color-background-body)) 55%,',
  'var(--color-background-body) 100%)',
].join(' ');

/**
 * The panel's edge, as a second background layer rather than a border colour.
 *
 * A uniform 1px ring contradicts the gradient: it would redraw the bottom edge
 * the wash just dissolved. So the border stays 1px of *transparent* and the ink
 * comes from this gradient, painted into the border box while `PANEL_GRADIENT`
 * is clipped to the padding box (see `backgroundClip` below). The hairline is
 * strongest at the top, where the panel is lightest and genuinely stands off the
 * window, and gone by 80% of the way down.
 *
 * `--color-border-emphasized` rather than `--color-border`: in light mode the
 * latter is #ebebeb, which is lighter than this theme's body colour and so
 * paints an invisible edge. #d4d4d4 / #525252 reads in both modes.
 */
const PANEL_EDGE = [
  'linear-gradient(180deg,',
  'var(--color-border-emphasized) 0%,',
  'color-mix(in srgb, var(--color-border-emphasized) 35%, transparent) 40%,',
  'transparent 80%)',
].join(' ');

/**
 * Panel lift, now a single inset highlight along the top edge and no drop
 * shadow at all.
 *
 * The old treatment was `--shadow-high` plus a wide pool underneath. Both are
 * wrong for this panel: every layer of `--shadow-high` is an outer shadow (plus
 * a full inset ring), and a pool under the panel paints a dark halo exactly
 * where the gradient's foot is supposed to be the same colour as the window —
 * it re-draws the bottom edge by hand. Separation now comes from the wash
 * itself; the only thing left to say is "the top of this is a raised surface",
 * which is what a 1px inset highlight says.
 */
const PANEL_SHADOW =
  'inset 0 var(--border-width) 0 color-mix(in srgb, var(--color-on-dark) 10%, transparent)';

/**
 * Selected nav pill. A tint of the text colour rather than a background token:
 * `--color-background-muted` is *darker* than the panel in dark mode, so the
 * selected row would sink into it instead of lifting off it. Mixing toward
 * `--color-text-primary` gives a dark tint on the light panel and a light tint
 * on the dark one, which is the direction the reference goes in both.
 */
const NAV_SELECTED_TINT = 'color-mix(in srgb, var(--color-text-primary) 8%, transparent)';

/**
 * The three macOS traffic-light colours, and the one blue in the app.
 *
 * Declared as custom properties on the app-shell rather than in `tokens`:
 * `defineTheme`'s `tokens` map is typed to Astryx's own closed set of token
 * names, and none of these is one of them. A component override's rule body is
 * emitted verbatim, so declaring them on the outermost element the theme owns
 * puts them in the inheritance path of everything inside the window — which is
 * what lets `styles/global.css` and the components reference `var(--...)` and
 * keeps every literal colour in this file, the token pipeline.
 *
 * The light colours are the macOS system values (Close/Minimize/Zoom in their
 * focused state) and are *not* mode-dependent: macOS paints the same three dots
 * whatever the app's appearance is, and the placeholders exist to mirror macOS,
 * not to match the theme.
 *
 * `--color-icon-update-pending` is the exception and is a `light-dark()` pair.
 * It is not `--color-icon-accent`: in this theme (neutral) that token resolves
 * to light-dark(#262626, #ebebeb) — a monochrome ink, not a blue — so
 * `<Icon color="accent">` would paint the pending glyph the same colour as
 * every other glyph. A blue defined here is scoped to the one control that
 * needs it instead of turning every accent icon in the app blue.
 *
 * Contrast, measured against both surfaces the glyph can land on (the panel's
 * head `--color-background-surface` and its foot, the window body). Non-text
 * ink, so the floor is WCAG 1.4.11's 3:1:
 *   light #0064E0: 5.39:1 on #ffffff, 4.42:1 on #E4E9F0
 *   dark  #2694FE: 4.87:1 on #262626, 6.42:1 on #08080A
 * `theme/__tests__/appTheme.test.ts` asserts all four.
 */
const WINDOW_CONTROL_COLORS = {
  '--color-window-control-close': '#FF5F57',
  '--color-window-control-minimize': '#FEBC2E',
  '--color-window-control-zoom': '#28C840',
  '--color-icon-update-pending': 'light-dark(#0064E0, #2694FE)',
} as const;

export const appTheme = defineTheme({
  name: 'invoiceapp',
  extends: neutralTheme,
  tokens: {
    /*
      Both re-tuned for the same reason: the panel has to separate from the
      window. Neutral's body is only 14 units off its dark surface, so a panel
      that fades *to* the body would have nowhere to fade from. These values are
      the two ends of `PANEL_GRADIENT` as much as they are window colours —
      dark runs #262626 -> #08080A, light runs #ffffff -> #E4E9F0, and both are
      wide enough for the wash to read. Written as [light, dark] pairs —
      `defineTheme` folds them into `light-dark()`.
    */
    '--color-background-body': ['#E4E9F0', '#08080A'],
    '--color-shadow': ['rgba(5, 54, 89, 0.16)', 'rgba(0, 0, 0, 0.55)'],
    /*
      Fallout from the body re-tune above, and the reason it is fixed here
      rather than by lifting the body back up. `layout-content` is transparent
      now, so supporting copy that used to sit on the white pane sits on
      #E4E9F0. Neutral's light secondary ink #737373 measures 4.74:1 on white
      but only 3.89:1 on #E4E9F0 — under the 4.5:1 AA floor for normal text.
      #656565 clears the floor on both surfaces it can land on (4.78:1 on the
      body/panel foot, 5.83:1 on `--color-background-surface`), and on every
      colour between them, since the panel gradient only interpolates the two.
      Darkening the ink rather than lightening the body keeps the light
      gradient's full #ffffff -> #E4E9F0 span, which is what makes the panel
      head read as lighter than the pane.

      Dark is neutral's #a3a3a3 untouched: 7.93:1 on #08080A, 6.00:1 on
      #262626. Restated as a pair only because `light-dark()` needs both.
    */
    '--color-text-secondary': ['#656565', '#a3a3a3'],
  },
  components: {
    /* The window itself: flat, and the deepest thing on screen. The gradient
       used to live here, which inverted the reference — a washed window under a
       flat panel reads as the panel being a hole rather than a surface. The
       explicit `none` is load-bearing: it is what a revert would have to delete,
       and the harness asserts the backdrop paints no gradient. */
    'app-shell': {
      base: {
        backgroundColor: 'var(--color-background-body)',
        backgroundImage: 'none',
        /* The window's own colours: the traffic lights it does (or, in the
           browser preview, does not) carry, and the blue the update glyph turns
           when one is waiting. Custom properties, so they inherit down to the
           sidebar rather than styling anything here. */
        ...WINDOW_CONTROL_COLORS,
      },
    },
    /*
      The content pane, and the reason the first cut of this design still read as
      inverted: core paints `astryx-layout-content` with
      `--color-background-surface` — #262626 in dark mode, the *same* colour as
      the panel's head. The panel then washed from that colour down to the body,
      so over most of its height the sidebar was darker than the pane it was
      supposed to float above.

      Transparent, not `--color-background-body`: the app-shell already paints the
      body colour and this pane covers all of it, so letting it through keeps one
      painted surface instead of two that have to agree. Cards, inputs and table
      rows keep `--color-background-surface` and now read as raised on top of it,
      which is what the reference does.
    */
    'layout-content': {
      base: { backgroundColor: 'transparent', backgroundImage: 'none' },
    },
    /* The region the sidebar sits in, not the sidebar. It stays see-through so
       the flat window colour runs edge to edge under the panel's margin — a
       painted strip here would give the panel a second, squarer outline. */
    'app-shell-sidenav': {
      base: { backgroundColor: 'transparent', backgroundImage: 'none' },
    },
    /*
      The pill panel, and the only gradient surface in the app.

      Two background layers with two different clips — the standard way to draw
      a gradient border on a rounded box, and the only one that follows
      `border-radius`:

        - `PANEL_GRADIENT` is clipped to the padding box, so it stops at the
          inside of the 1px border.
        - `PANEL_EDGE` fills the border box, so the ring is all that shows of it.
        - `border-color: transparent` is what lets the second layer through.
          `background-color` must be transparent for the same reason: the colour
          is painted below every layer and clipped to the border box, so any
          colour here would tint the ring — including at the bottom, where the
          edge is deliberately absent.
    */
    'side-nav': {
      base: {
        backgroundColor: 'transparent',
        backgroundImage: `${PANEL_GRADIENT}, ${PANEL_EDGE}`,
        backgroundOrigin: 'border-box',
        backgroundClip: 'padding-box, border-box',
        borderRadius: PANEL_RADIUS,
        borderWidth: 'var(--border-width)',
        borderStyle: 'solid',
        borderColor: 'transparent',
        boxShadow: PANEL_SHADOW,
      },
    },
    'side-nav-item': {
      base: { borderRadius: 'var(--radius-element)' },
      selected: { backgroundColor: NAV_SELECTED_TINT },
    },
    /*
      Ghost is the sidebar's icon-button variant (SideNavCollapseButton renders
      one), and the component override surface has no way to scope a rule to a
      subtree — so this is app-wide by construction. That is defensible rather
      than merely tolerable: ghost is the lowest-emphasis variant everywhere,
      and the reference's top-row glyphs are exactly that — no fill at rest,
      secondary ink, a surface that only appears under the pointer.
    */
    /*
      `backgroundImage: 'none'` in the interaction states is load-bearing, not
      tidiness. Core paints Button's overlays as *images*, not colours: ghost
      carries `x1ilzqfv`/`xq8i9tn`, which are

        .x1ilzqfv:hover  { background-image: linear-gradient(var(--color-overlay-hover),   var(--color-overlay-hover)) }
        .xq8i9tn:active  { background-image: linear-gradient(var(--color-overlay-pressed), var(--color-overlay-pressed)) }

      (astryx.css:1152 and :1106). A `background-color` set here does not
      replace that image — it composites *under* it, so restating the same
      overlay token would paint the tint twice and every ghost control in the
      app would hover at double strength. Clearing the image leaves exactly one
      coat, drawn from the colour written below. It wins over core's rule
      despite core's `:not(#\#)` specificity padding because theme overrides are
      injected into `@layer astryx-theme`, above `@layer astryx-base`.
    */
    button: {
      'variant:ghost': {
        backgroundColor: 'transparent',
        borderRadius: 'var(--radius-element)',
        color: 'var(--color-icon-secondary)',
        ':hover': {
          backgroundColor: 'var(--color-overlay-hover)',
          backgroundImage: 'none',
          color: 'var(--color-text-primary)',
        },
        ':active': {
          backgroundColor: 'var(--color-overlay-pressed)',
          backgroundImage: 'none',
        },
      },
    },
  },
});
