/**
 * The theme is data, so it is tested as data.
 *
 * The root vitest project runs in `environment: 'node'` — there is no DOM to
 * render into and no layout to measure. That is not much of a loss here: every
 * decision in `appTheme.ts` is a value in an object, and the failure mode worth
 * guarding against is a value silently reverting to neutral's, which a render
 * test would not catch any better.
 *
 * Two rules these tests follow. Assertions are on *resolved values*, never on
 * mere presence — `expect(x).toBeDefined()` passes just as happily against the
 * base theme. And the light/dark halves of every pair are asserted separately,
 * because a theme that is right in dark mode and unreadable in light mode is
 * the exact bug this app ships into (Light/Dark/Auto are all user-selectable).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { generateThemeCSS } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';

import { appTheme } from '../appTheme';

/** `light-dark(a, b)` -> `['a', 'b']`, splitting on the top-level comma only. */
function splitLightDark(value: string): [light: string, dark: string] {
  const inner = /^light-dark\((.*)\)$/s.exec(value)?.[1];
  if (inner === undefined) throw new Error(`not a light-dark() value: ${value}`);
  let depth = 0;
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === '(') depth++;
    else if (inner[i] === ')') depth--;
    else if (inner[i] === ',' && depth === 0) {
      return [inner.slice(0, i).trim(), inner.slice(i + 1).trim()];
    }
  }
  throw new Error(`light-dark() without two arguments: ${value}`);
}

/** Crude brightness proxy for a `#rrggbb` literal — enough to order two inks. */
function hexSum(value: string): number {
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim())?.[1];
  if (hex === undefined) throw new Error(`not a 6-digit hex colour: ${value}`);
  return parseInt(hex.slice(0, 2), 16) + parseInt(hex.slice(2, 4), 16) + parseInt(hex.slice(4), 16);
}

type Rule = Record<string, string | Record<string, string>>;

const tokenMap = appTheme.tokens as Record<string, string | undefined>;
const componentMap = appTheme.components as Record<
  string,
  Record<string, Rule | undefined> | undefined
>;

/*
  These three throw rather than return undefined on a miss. `strictNullChecks`
  plus `noUncheckedIndexedAccess` would otherwise force a `?.` at every call
  site, and `expect(undefined).not.toBe(x)` is a test that passes when the whole
  override has been deleted — the exact regression these tests exist to catch.
*/
function token(name: string): string {
  const value = tokenMap[name];
  if (value === undefined) throw new Error(`theme has no token ${name}`);
  return value;
}

function rule(component: string, key: string): Rule {
  const found = componentMap[component]?.[key];
  if (found === undefined) throw new Error(`theme has no ${component} rule for "${key}"`);
  return found;
}

function prop(component: string, key: string, name: string): string {
  const value = rule(component, key)[name];
  if (typeof value !== 'string') throw new Error(`${component} "${key}" has no ${name}`);
  return value;
}

describe('appTheme identity', () => {
  it('is named invoiceapp — App.tsx and every generated selector key off this', () => {
    expect(appTheme.name).toBe('invoiceapp');
  });

  it('inherits neutral rather than restating it', () => {
    // A theme that failed to extend would carry only the handful of tokens
    // written in appTheme.ts. Neutral ships ~170.
    expect(Object.keys(tokenMap).length).toBeGreaterThan(100);
    expect(token('--font-size-base')).toBe(
      (neutralTheme.tokens as Record<string, string | undefined>)['--font-size-base'],
    );
  });

  it('is not marked built, so <Theme> still injects its CSS at runtime', () => {
    // The base *is* built (its CSS is precompiled under the "neutral" scope).
    // If that flag leaked through `extends`, Theme would skip injection and
    // every override below would silently do nothing in the running app.
    expect((appTheme as { __built?: boolean }).__built).toBeUndefined();
    expect((neutralTheme as { __built?: boolean }).__built).toBe(true);
  });
});

describe('window/panel separation tokens', () => {
  it('darkens the window body in both modes so the panel can sit above it', () => {
    const [light, dark] = splitLightDark(token('--color-background-body'));
    expect(light).toBe('#EEF1F5');
    expect(dark).toBe('#0D0D0F');
    // The point of the override: further from the panel surface than neutral's.
    const [neutralLight, neutralDark] = splitLightDark(
      String((neutralTheme.tokens as Record<string, string | undefined>)['--color-background-body']),
    );
    expect(light).not.toBe(neutralLight);
    expect(dark).not.toBe(neutralDark);
  });

  it('keeps the panel surface distinct from the window in both modes', () => {
    const [bodyLight, bodyDark] = splitLightDark(token('--color-background-body'));
    const [surfaceLight, surfaceDark] = splitLightDark(token('--color-background-surface'));
    expect(surfaceLight).not.toBe(bodyLight);
    expect(surfaceDark).not.toBe(bodyDark);
  });

  it('strengthens the shadow colour per mode', () => {
    const [light, dark] = splitLightDark(token('--color-shadow'));
    expect(light).toBe('rgba(5, 54, 89, 0.16)');
    expect(dark).toBe('rgba(0, 0, 0, 0.55)');
  });
});

describe('side-nav renders as a floating pill panel', () => {
  const base = rule('side-nav', 'base');

  it('carries surface, radius, hairline border and shadow together', () => {
    expect(base).toEqual({
      backgroundColor: 'var(--color-background-surface)',
      borderRadius: 'calc(var(--radius-container) * 1.5)',
      borderWidth: 'var(--border-width)',
      borderStyle: 'solid',
      borderColor: 'var(--color-border)',
      boxShadow:
        'var(--shadow-high), 0 var(--spacing-2) var(--spacing-8) color-mix(in srgb, var(--color-shadow) 60%, transparent)',
    });
  });

  it('resolves to the ~18px corner the reference reads, off the inherited scale', () => {
    // The multiplier is only meaningful against the scale it multiplies: if
    // neutral ever reshapes --radius-container, the panel silently leaves the
    // 18-20px band the reference sits in and this is where that shows up.
    const rem = Number(/^([\d.]+)rem$/.exec(token('--radius-container'))?.[1]);
    expect(Number.isNaN(rem)).toBe(false);
    expect(rem * 16 * 1.5).toBeCloseTo(18, 5);
  });

  it('adds a shadow layer beyond the inherited elevation token', () => {
    // --shadow-high alone is tuned for dialogs over a scrim; the extra pool is
    // what lifts the panel off a near-black window.
    const boxShadow = prop('side-nav', 'base', 'boxShadow');
    expect(boxShadow.startsWith('var(--shadow-high),')).toBe(true);
    expect(boxShadow).toContain('var(--color-shadow)');
  });
});

describe('window background gradient', () => {
  const gradient = prop('app-shell', 'base', 'backgroundImage');

  it('is a single diagonal gradient built only from background tokens', () => {
    expect(gradient).toBe(
      'linear-gradient(155deg, ' +
        'color-mix(in srgb, var(--color-background-body) 94%, var(--color-on-dark)) 0%, ' +
        'var(--color-background-body) 45%, ' +
        'color-mix(in srgb, var(--color-background-body) 88%, var(--color-on-light)) 100%)',
    );
  });

  it('darkens toward the end stop in both modes', () => {
    // --color-on-dark is white and --color-on-light is black in *either* mode,
    // so the light stop leads and the dark stop trails whichever mode is on.
    // Assert that here, because the whole two-mode claim rests on it.
    // Mode-independent by construction: both are single values, not pairs...
    const onDark = token('--color-on-dark');
    const onLight = token('--color-on-light');
    expect(onDark).not.toContain('light-dark(');
    expect(onLight).not.toContain('light-dark(');
    // ...and on-dark is the lighter of the two, so the first stop lightens and
    // the last darkens no matter which mode is active.
    expect(hexSum(onDark)).toBeGreaterThan(hexSum(onLight));
    expect(gradient.indexOf('--color-on-dark')).toBeLessThan(gradient.indexOf('--color-on-light'));
  });

  it('leaves the sidebar region see-through so the gradient runs under the panel', () => {
    expect(rule('app-shell-sidenav', 'base')).toEqual({
      backgroundColor: 'transparent',
      backgroundImage: 'none',
    });
  });
});

describe('nav items and ghost icon buttons', () => {
  it('gives nav items a rounded pill and a mode-agnostic selected tint', () => {
    expect(rule('side-nav-item', 'base')).toEqual({
      borderRadius: 'var(--radius-element)',
    });
    expect(rule('side-nav-item', 'selected')).toEqual({
      backgroundColor: 'color-mix(in srgb, var(--color-text-primary) 8%, transparent)',
    });
  });

  it('makes ghost buttons unfilled at rest with a surface only on hover', () => {
    const ghost = rule('button', 'variant:ghost');
    expect(ghost.backgroundColor).toBe('transparent');
    expect(ghost.borderRadius).toBe('var(--radius-element)');
    expect(ghost.color).toBe('var(--color-icon-secondary)');
    expect(ghost[':hover']).toEqual({
      backgroundColor: 'var(--color-overlay-hover)',
      backgroundImage: 'none',
      color: 'var(--color-text-primary)',
    });
    expect(ghost[':active']).toEqual({
      backgroundColor: 'var(--color-overlay-pressed)',
      backgroundImage: 'none',
    });
  });

  it('clears the inherited overlay image so the hover tint is single-strength', () => {
    // Core paints ghost's hover/pressed overlay as a background-*image*
    // (astryx.css:1152, :1106), which composites on top of any
    // background-color rather than replacing it. Without these two
    // `backgroundImage: none` declarations the same overlay token is painted
    // twice and every ghost control in the app hovers at double strength.
    // Asserted on both the object and the emitted CSS: this is the property
    // whose deletion is the regression, so deleting it must fail here.
    const ghost = rule('button', 'variant:ghost');
    for (const state of [':hover', ':active'] as const) {
      const styles = ghost[state];
      if (typeof styles !== 'object') throw new Error(`ghost has no ${state} block`);
      expect(styles.backgroundImage).toBe('none');
      // The colour it replaces it with must be a single overlay layer, not a
      // stack of gradients that would reintroduce the doubling by hand.
      expect(styles.backgroundColor).not.toContain('gradient');
    }
  });

  it('keeps the ghost radius below the panel radius', () => {
    // "Radius on the small side" from the reference: the glyph buttons must not
    // compete with the panel corner they sit inside.
    const element = Number(/^([\d.]+)rem$/.exec(token('--radius-element'))?.[1]);
    const container = Number(/^([\d.]+)rem$/.exec(token('--radius-container'))?.[1]);
    expect(element).toBeLessThan(container * 1.5);
  });
});

describe('generated CSS', () => {
  const css = generateThemeCSS(appTheme);
  const all = `${css.prose}\n${css.component}`;

  it('emits every override against the class the components actually render', () => {
    for (const selector of [
      '.astryx-app-shell {',
      '.astryx-app-shell-sidenav {',
      '.astryx-side-nav {',
      '.astryx-side-nav-item {',
      '.astryx-side-nav-item.selected {',
      '.astryx-button.ghost {',
      '.astryx-button.ghost:hover {',
      '.astryx-button.ghost:active {',
    ]) {
      expect(all).toContain(selector);
    }
  });

  it('emits background-image: none in both ghost interaction rules', () => {
    // The composited result cannot be measured in a node environment, so this
    // asserts the next best thing: the declaration that neutralises core's
    // overlay image reaches the stylesheet, in the same rule as the colour.
    for (const selector of ['.astryx-button.ghost:hover', '.astryx-button.ghost:active']) {
      const body = all.split(`${selector} {`)[1]?.split('}')[0];
      if (body === undefined) throw new Error(`no emitted rule for ${selector}`);
      expect(body).toContain('background-image: none;');
      expect(body).toContain('background-color: var(--color-overlay-');
    }
  });

  it('is the theme App.tsx actually hands to <Theme>', () => {
    /*
      Everything above tests an object no one is obliged to use. `App.tsx`
      reverting `theme={appTheme}` to `theme={neutralTheme}` would leave this
      whole file green while the gradient, the pill, the shadow, the nav tint
      and the ghost override all vanish from the running app.

      This is a source-text assertion because the root vitest project runs in
      `environment: 'node'`: there is no DOM, so <App> cannot be mounted and
      the prop cannot be read off a rendered tree. It is deliberately narrow —
      the import and the one prop — so ordinary edits to App.tsx do not trip
      it, and only the two edits that actually unwire the theme do.
    */
    const app = readFileSync(fileURLToPath(new URL('../../App.tsx', import.meta.url)), 'utf8');
    expect(app).toMatch(/import\s*\{\s*appTheme\s*\}\s*from\s*'\.\/theme\/appTheme'/);
    expect(app).toMatch(/<Theme\b[^>]*\btheme=\{appTheme\}/);
  });

  it('scopes the rules to this theme, not to neutral', () => {
    expect(all).toContain('[data-astryx-theme="invoiceapp"]');
    expect(all).not.toContain('[data-astryx-theme="neutral"]');
  });
});
