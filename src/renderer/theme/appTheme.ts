/**
 * The app's own theme: neutral, plus the handful of surface decisions that make
 * the sidebar read as a floating pill panel on a gradient window.
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
 * Panel lift. `--shadow-high` alone is tuned for dialogs over a dimmed
 * backdrop; over a near-black window it disappears. The second layer is the one
 * that does the work — a wide, soft pool under the panel, coloured with
 * `--color-shadow` (itself re-tuned below) so it tracks the colour mode instead
 * of hardcoding a black that would grey out the light window.
 */
const PANEL_SHADOW =
  'var(--shadow-high), 0 var(--spacing-2) var(--spacing-8) color-mix(in srgb, var(--color-shadow) 60%, transparent)';

/**
 * The window wash behind the panel.
 *
 * Built entirely from `--color-background-body` so it stays correct in both
 * modes. `--color-on-dark` (white) and `--color-on-light` (near-black) name the
 * ink that sits on a surface, not a colour mode — neither is a `light-dark()`
 * pair — so mixing toward them lightens the top-left and darkens the
 * bottom-right whichever way the app is running. 155deg puts the dark end at
 * bottom-right, as in the reference.
 */
const WINDOW_GRADIENT = [
  'linear-gradient(155deg,',
  'color-mix(in srgb, var(--color-background-body) 94%, var(--color-on-dark)) 0%,',
  'var(--color-background-body) 45%,',
  'color-mix(in srgb, var(--color-background-body) 88%, var(--color-on-light)) 100%)',
].join(' ');

/**
 * Selected nav pill. A tint of the text colour rather than a background token:
 * `--color-background-muted` is *darker* than the panel in dark mode, so the
 * selected row would sink into it instead of lifting off it. Mixing toward
 * `--color-text-primary` gives a dark tint on the light panel and a light tint
 * on the dark one, which is the direction the reference goes in both.
 */
const NAV_SELECTED_TINT = 'color-mix(in srgb, var(--color-text-primary) 8%, transparent)';

export const appTheme = defineTheme({
  name: 'invoiceapp',
  extends: neutralTheme,
  tokens: {
    /*
      Both re-tuned for the same reason: the panel has to separate from the
      window. Neutral's body is only 14 units off its dark surface, and its
      shadow at 0.3 alpha cannot carve a panel out of it. Written as
      [light, dark] pairs — `defineTheme` folds them into `light-dark()`.
    */
    '--color-background-body': ['#EEF1F5', '#0D0D0F'],
    '--color-shadow': ['rgba(5, 54, 89, 0.16)', 'rgba(0, 0, 0, 0.55)'],
  },
  components: {
    /* The window itself. Painting the gradient as a background *image* leaves
       the variant's background-color underneath as the fallback, so a browser
       without color-mix still gets the flat wash. */
    'app-shell': {
      base: { backgroundImage: WINDOW_GRADIENT },
    },
    /* The region the sidebar sits in, not the sidebar. It has to be see-through
       or the gradient stops at the panel's margin and the panel looks inset
       into a flat strip rather than floating on the window. */
    'app-shell-sidenav': {
      base: { backgroundColor: 'transparent', backgroundImage: 'none' },
    },
    /* The pill panel. */
    'side-nav': {
      base: {
        backgroundColor: 'var(--color-background-surface)',
        borderRadius: PANEL_RADIUS,
        borderWidth: 'var(--border-width)',
        borderStyle: 'solid',
        borderColor: 'var(--color-border)',
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
