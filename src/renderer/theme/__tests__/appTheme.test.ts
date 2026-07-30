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
    expect(light).toBe('#E4E9F0');
    expect(dark).toBe('#08080A');
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

/** WCAG 2.x relative luminance of a `#rrggbb` literal. */
function relativeLuminance(value: string): number {
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim())?.[1];
  if (hex === undefined) throw new Error(`not a 6-digit hex colour: ${value}`);
  const channels = [0, 2, 4].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }) as [number, number, number];
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

/** WCAG contrast ratio between two `#rrggbb` literals, 1:1 .. 21:1. */
function contrastRatio(a: string, b: string): number {
  const [x, y] = [relativeLuminance(a), relativeLuminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/*
  The floor this file exists to hold from now on.

  `layout-content` is transparent, so text no longer has one guaranteed white
  pane under it: supporting copy lands on `--color-background-body` in the
  content area and on the panel's foot, which is the same token. Retuning the
  light body to #E4E9F0 without moving the ink is what put secondary text at
  3.89:1 — passing on white, failing on the pane. Both surfaces are asserted
  because only checking the friendlier one is how that shipped.
*/
describe('text contrast (WCAG AA, 4.5:1 for normal text)', () => {
  const AA_NORMAL = 4.5;

  const surfaces = (index: 0 | 1): Array<[name: string, color: string]> => [
    ['body/panel foot', splitLightDark(token('--color-background-body'))[index]],
    ['surface (cards, inputs, rows)', splitLightDark(token('--color-background-surface'))[index]],
  ];

  for (const [modeName, index] of [
    ['light', 0],
    ['dark', 1],
  ] as const) {
    for (const inkToken of ['--color-text-secondary', '--color-text-primary']) {
      for (const [surfaceName, background] of surfaces(index)) {
        it(`${modeName}: ${inkToken} on ${surfaceName} clears ${AA_NORMAL}:1`, () => {
          const ink = splitLightDark(token(inkToken))[index];
          expect(contrastRatio(ink, background)).toBeGreaterThanOrEqual(AA_NORMAL);
        });
      }
    }
  }

  /*
    The invoice tab strip, which introduces one new ink pairing: primary text on
    a 10% tint of itself over the window body. The tint is a `color-mix()` with
    transparent, so it composites over whatever is behind it — here always the
    flat window (`layout-content` is transparent and the app-shell paints the
    body colour), which is what makes the composite computable off two tokens.

    The inactive pill is *not* tinted, and this block is where that decision is
    held: the same maths run at 3% put secondary ink at 4.52:1 in light mode and
    at 10% at 3.92:1, i.e. under the floor. Flat inactive pills keep their ink on
    the surface the loop above already measures.
  */
  describe('invoice tab strip', () => {
    const tabColors = rule('app-shell', 'base');

    /** `color-mix(in srgb, X p%, transparent)` over `background`, as #rrggbb. */
    function composite(ink: string, background: string, percent: number): string {
      const channels = (value: string): [number, number, number] => {
        const hex = /^#([0-9a-f]{6})$/i.exec(value.trim())?.[1];
        if (hex === undefined) throw new Error(`not a 6-digit hex colour: ${value}`);
        return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
      };
      const [front, back] = [channels(ink), channels(background)];
      const alpha = percent / 100;
      const mixed = front.map((value, i) => Math.round(value * alpha + back[i]! * (1 - alpha)));
      return `#${mixed.map((value) => value.toString(16).padStart(2, '0')).join('')}`;
    }

    it('mixes the active fill toward the ink, so it lifts in dark and darkens in light', () => {
      // A background *token* would not work: --color-background-muted is darker
      // than the window in dark mode, so the active pill would sink.
      const fill = String(tabColors['--color-invoice-tab-surface-active']);
      expect(fill).toMatch(
        /^color-mix\(in srgb, var\(--color-text-primary\) \d+%, transparent\)$/,
      );
      expect(String(tabColors['--color-invoice-tab-ink'])).toBe('var(--color-text-secondary)');
      expect(String(tabColors['--color-invoice-tab-ink-active'])).toBe('var(--color-text-primary)');
    });

    it('outlines the active pill with the edge token that reads in both modes', () => {
      // Not `--color-border`: in light mode that is #ebebeb, lighter than this
      // theme's body colour, so the hairline would be invisible on exactly the
      // surface the pill sits on. Same reason `PANEL_EDGE` uses the emphasised
      // token — see the panel-edge assertions above.
      expect(String(tabColors['--color-invoice-tab-border-active'])).toBe(
        'var(--color-border-emphasized)',
      );
    });

    const percent = Number(
      /(\d+)%/.exec(String(tabColors['--color-invoice-tab-surface-active']))?.[1],
    );

    for (const [modeName, index] of [
      ['light', 0],
      ['dark', 1],
    ] as const) {
      it(`${modeName}: the active pill's ink clears ${AA_NORMAL}:1 on its own fill`, () => {
        const ink = splitLightDark(token('--color-text-primary'))[index];
        const body = splitLightDark(token('--color-background-body'))[index];
        expect(Number.isNaN(percent)).toBe(false);
        expect(contrastRatio(ink, composite(ink, body, percent))).toBeGreaterThanOrEqual(
          AA_NORMAL,
        );
      });

      it(`${modeName}: an inactive pill's ink clears ${AA_NORMAL}:1 on the flat window`, () => {
        const ink = splitLightDark(token('--color-text-secondary'))[index];
        const body = splitLightDark(token('--color-background-body'))[index];
        expect(contrastRatio(ink, body)).toBeGreaterThanOrEqual(AA_NORMAL);
      });
    }

    it('is why the inactive pill has no fill: light mode has no headroom for one', () => {
      // The number that decided the design. Filling an inactive pill with the
      // active tint and keeping secondary ink is below AA in light mode, so
      // "only the active one is filled" is a contrast rule, not just a look.
      const ink = splitLightDark(token('--color-text-secondary'))[0];
      const body = splitLightDark(token('--color-background-body'))[0];
      const primary = splitLightDark(token('--color-text-primary'))[0];
      expect(contrastRatio(ink, composite(primary, body, percent))).toBeLessThan(AA_NORMAL);
    });
  });

  it('exempts only --color-text-disabled, which WCAG 1.4.3 excludes', () => {
    // #a3a3a3 measures 2.07:1 on the light pane and 2.52:1 on white — nowhere
    // near AA, and deliberately so: disabled controls are outside 1.4.3. This
    // asserts the exemption is narrow, i.e. that this is the *only* ink token
    // the loop above skips. The theme defines no tertiary/placeholder ink.
    const inks = Object.keys(tokenMap).filter((name) => /^--color-text-/.test(name));
    const unchecked = inks.filter(
      (name) => !['--color-text-secondary', '--color-text-primary'].includes(name),
    );
    expect(unchecked).toContain('--color-text-disabled');
    expect(inks).not.toContain('--color-text-tertiary');
  });

  it('does not fix light mode by flattening the light gradient', () => {
    // The other way out of the finding was lifting the body back toward white.
    // The panel head is `--color-background-surface` and its foot is the body;
    // they have to stay far enough apart for the wash to read at all.
    const [surfaceLight] = splitLightDark(token('--color-background-surface'));
    const [bodyLight] = splitLightDark(token('--color-background-body'));
    expect(hexSum(surfaceLight) - hexSum(bodyLight)).toBeGreaterThanOrEqual(40);
  });
});

/*
  The window's own colours, declared as custom properties on the app-shell rather
  than in `tokens` (defineTheme types that map to Astryx's own closed token set).
  Asserted here, and asserted *literally*: these are the macOS system colours,
  and a placeholder cluster in some other palette is a preview of a window that
  does not exist.
*/
describe('window-control and update-pending colours', () => {
  const windowControls = rule('app-shell', 'base');

  it('paints the three macOS traffic-light colours', () => {
    expect(windowControls['--color-window-control-close']).toBe('#FF5F57');
    expect(windowControls['--color-window-control-minimize']).toBe('#FEBC2E');
    expect(windowControls['--color-window-control-zoom']).toBe('#28C840');
  });

  it('keeps the light colours mode-independent, because macOS does', () => {
    // A `light-dark()` pair here would be the mistake: the dots stand in for OS
    // chrome, which does not follow the app's appearance.
    for (const name of [
      '--color-window-control-close',
      '--color-window-control-minimize',
      '--color-window-control-zoom',
    ]) {
      expect(windowControls[name]).toMatch(/^#[0-9A-F]{6}$/);
    }
  });

  it('reaches the stylesheet on the element everything inherits from', () => {
    // Declared, not merely written: the whole mechanism is inheritance from
    // `.astryx-app-shell` down to the sidebar's band.
    const emitted = generateThemeCSS(appTheme).component;
    const body = emitted.split('.astryx-app-shell {')[1]?.split('}')[0];
    if (body === undefined) throw new Error('no emitted rule for .astryx-app-shell');
    for (const name of [
      '--color-window-control-close',
      '--color-window-control-minimize',
      '--color-window-control-zoom',
      '--color-icon-update-pending',
    ]) {
      expect(body).toContain(`${name}:`);
    }
  });

  /*
    The update glyph's blue is non-text ink, so WCAG 1.4.11 applies: 3:1 against
    the surface behind it. It can land on either end of the panel gradient — the
    head is `--color-background-surface`, the foot is the window body — so both
    are measured, in both modes. This is the reason the blue is a light/dark pair
    rather than one colour: #0064E0 measures 1.94:1 on the dark panel head.
  */
  it('keeps the pending blue legible on the panel head and foot, both modes', () => {
    const AA_NON_TEXT = 3;
    const [inkLight, inkDark] = splitLightDark(
      String(windowControls['--color-icon-update-pending']),
    );
    const [headLight, headDark] = splitLightDark(token('--color-background-surface'));
    const [footLight, footDark] = splitLightDark(token('--color-background-body'));
    for (const [ink, surface] of [
      [inkLight, headLight],
      [inkLight, footLight],
      [inkDark, headDark],
      [inkDark, footDark],
    ] as const) {
      expect(contrastRatio(ink, surface)).toBeGreaterThanOrEqual(AA_NON_TEXT);
    }
  });

  it('is a blue, not neutral’s monochrome accent ink', () => {
    // The trap this pins: `<Icon color="accent">` resolves to
    // --color-icon-accent, which in this theme is light-dark(#262626, #ebebeb).
    // A "blue" equal to that token is the bug, not the fix.
    const [inkLight, inkDark] = splitLightDark(
      String(windowControls['--color-icon-update-pending']),
    );
    for (const ink of [inkLight, inkDark]) {
      const hex = /^#([0-9a-f]{6})$/i.exec(ink)?.[1] ?? '';
      const [red, green, blue] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
      expect(blue).toBeGreaterThan((red ?? 0) + 60);
      expect(blue).toBeGreaterThan((green ?? 0) + 60);
    }
    expect(String(windowControls['--color-icon-update-pending'])).not.toBe(
      token('--color-icon-accent'),
    );
  });
});

const PANEL_GRADIENT =
  'linear-gradient(180deg, ' +
  'var(--color-background-surface) 0%, ' +
  'color-mix(in srgb, var(--color-background-surface) 55%, var(--color-background-body)) 55%, ' +
  'var(--color-background-body) 100%)';

const PANEL_EDGE =
  'linear-gradient(180deg, ' +
  'var(--color-border-emphasized) 0%, ' +
  'color-mix(in srgb, var(--color-border-emphasized) 35%, transparent) 40%, ' +
  'transparent 80%)';

describe('side-nav renders as a floating pill panel', () => {
  const base = rule('side-nav', 'base');

  it('carries the wash, the fading edge, radius and a top inset highlight', () => {
    expect(base).toEqual({
      backgroundColor: 'transparent',
      backgroundImage: `${PANEL_GRADIENT}, ${PANEL_EDGE}`,
      backgroundOrigin: 'border-box',
      backgroundClip: 'padding-box, border-box',
      borderRadius: 'calc(var(--radius-container) * 1.5)',
      borderWidth: 'var(--border-width)',
      borderStyle: 'solid',
      borderColor: 'transparent',
      boxShadow: 'inset 0 var(--border-width) 0 color-mix(in srgb, var(--color-on-dark) 10%, transparent)',
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

  it('lifts the panel with an inset top highlight, not an outer shadow', () => {
    // The old treatment was --shadow-high plus a pool underneath. Both paint
    // *below* the panel, which redraws the bottom edge the gradient exists to
    // dissolve. Nothing here may be an outer shadow.
    const boxShadow = prop('side-nav', 'base', 'boxShadow');
    expect(boxShadow.startsWith('inset ')).toBe(true);
    expect(boxShadow).not.toContain('var(--shadow-');
    // One layer only: the sole commas left are color-mix's own, inside parens,
    // so strip parenthesised groups until none nest and then look for a comma.
    let flattened = boxShadow;
    for (let previous = ''; previous !== flattened; ) {
      previous = flattened;
      flattened = flattened.replace(/\([^()]*\)/g, '');
    }
    expect(flattened).not.toContain(',');
    expect(boxShadow).toContain('var(--color-on-dark)');
  });
});

describe('the panel carries the gradient and the window does not', () => {
  const gradient = prop('side-nav', 'base', 'backgroundImage');

  it('washes the panel vertically from the surface colour to the body colour', () => {
    expect(gradient).toBe(`${PANEL_GRADIENT}, ${PANEL_EDGE}`);
    // Vertical, top to bottom — the reference's panel is lightest at its head.
    expect(PANEL_GRADIENT.startsWith('linear-gradient(180deg,')).toBe(true);
  });

  it('ends the wash on exactly the body colour, so the panel foot dissolves', () => {
    // The single load-bearing claim of the whole design: the last stop is the
    // window's own colour, unmixed. Anything else leaves a visible bottom edge.
    const lastStop = PANEL_GRADIENT.slice(PANEL_GRADIENT.lastIndexOf(',') + 1).trim();
    expect(lastStop).toBe('var(--color-background-body) 100%)');
    expect(PANEL_GRADIENT.startsWith('linear-gradient(180deg, var(--color-background-surface) 0%,')).toBe(
      true,
    );
  });

  it('is mode-correct by construction, not by a mix that happens to work', () => {
    // Both ends are light-dark() pairs, so "surface at the top, body at the
    // bottom" is true in light mode and in dark mode without a second gradient.
    for (const name of ['--color-background-surface', '--color-background-body']) {
      const [light, dark] = splitLightDark(token(name));
      expect(light).not.toBe(dark);
      expect(hexSum(light)).toBeGreaterThan(hexSum(dark));
    }
    // ...and the panel head is lighter than the window in both modes.
    const [surfaceLight, surfaceDark] = splitLightDark(token('--color-background-surface'));
    const [bodyLight, bodyDark] = splitLightDark(token('--color-background-body'));
    expect(hexSum(surfaceLight)).toBeGreaterThan(hexSum(bodyLight));
    expect(hexSum(surfaceDark)).toBeGreaterThan(hexSum(bodyDark));
  });

  it('fades the edge out before the bottom, where panel and window are equal', () => {
    // A uniform ring would contradict the wash. The last stop must be
    // transparent, and it must arrive before the gradient's end.
    expect(PANEL_EDGE).toContain('var(--color-border-emphasized) 0%');
    expect(PANEL_EDGE.trimEnd().endsWith('transparent 80%)')).toBe(true);
    // Drawn through the border box while the wash is clipped to the padding
    // box: delete either clip and the ring becomes a solid 1px outline again.
    expect(prop('side-nav', 'base', 'backgroundClip')).toBe('padding-box, border-box');
    expect(prop('side-nav', 'base', 'backgroundOrigin')).toBe('border-box');
    expect(prop('side-nav', 'base', 'borderColor')).toBe('transparent');
    // Any painted background-color would tint the ring, including at the foot.
    expect(prop('side-nav', 'base', 'backgroundColor')).toBe('transparent');
  });

  it('leaves the window flat — the gradient used to live here and must not return', () => {
    expect(rule('app-shell', 'base')).toEqual({
      backgroundColor: 'var(--color-background-body)',
      backgroundImage: 'none',
      '--color-window-control-close': '#FF5F57',
      '--color-window-control-minimize': '#FEBC2E',
      '--color-window-control-zoom': '#28C840',
      '--color-icon-update-pending': 'light-dark(#0064E0, #2694FE)',
      // The invoice tab strip's colours, declared here for the same reason and
      // asserted in their own block below.
      '--color-invoice-tab-ink': 'var(--color-text-secondary)',
      '--color-invoice-tab-ink-active': 'var(--color-text-primary)',
      '--color-invoice-tab-surface-active':
        'color-mix(in srgb, var(--color-text-primary) 10%, transparent)',
      '--color-invoice-tab-border-active': 'var(--color-border-emphasized)',
    });
  });

  it('leaves the sidebar region see-through so the flat window runs under the panel', () => {
    expect(rule('app-shell-sidenav', 'base')).toEqual({
      backgroundColor: 'transparent',
      backgroundImage: 'none',
    });
  });

  it('strips the content pane back to the window colour', () => {
    // Core paints `astryx-layout-content` with --color-background-surface, which
    // is the panel gradient's *first stop*. Left alone, the pane and the panel's
    // head are the same colour and the panel reads as the darker surface — the
    // exact inversion this design exists to fix. See-through, so the app-shell's
    // body colour is the only thing painting the window.
    expect(rule('layout-content', 'base')).toEqual({
      backgroundColor: 'transparent',
      backgroundImage: 'none',
    });
  });

  it('paints exactly one gradient across every component override', () => {
    // The screenshot harness asserts the same thing in a real browser; this is
    // the source-side half, and it catches a gradient added to any other
    // component without anyone having to remember to look.
    const withGradient = Object.entries(componentMap).flatMap(([name, rules]) =>
      Object.entries(rules ?? {})
        .filter(([, block]) => JSON.stringify(block ?? {}).includes('gradient'))
        .map(([key]) => `${name}.${key}`),
    );
    expect(withGradient).toEqual(['side-nav.base']);
  });
});

describe('nav items and ghost icon buttons', () => {
  it('gives nav items a rounded pill and a mode-agnostic selected tint', () => {
    expect(rule('side-nav-item', 'base')).toEqual({
      borderRadius: 'var(--radius-element)',
      // The other half of the section-caption rule below. Not decoration: the
      // item root is a descendant of the section root, so without these two the
      // uppercase and the tracking meant for the caption reach every label.
      textTransform: 'none',
      letterSpacing: 'normal',
    });
    expect(rule('side-nav-item', 'selected')).toEqual({
      backgroundColor: 'color-mix(in srgb, var(--color-text-primary) 8%, transparent)',
    });
  });

  it('uppercases and tracks out the group captions, and only those', () => {
    // Set on the section because the caption's own StyleX rule outranks
    // anything written for it; neither property is one that rule declares, so
    // both inherit down to it. The pair is only correct together — the reset on
    // `side-nav-item` above is what stops it reaching the rows.
    expect(rule('side-nav-section', 'base')).toEqual({
      textTransform: 'uppercase',
      letterSpacing: '0.06em',
    });
    const item = rule('side-nav-item', 'base');
    expect(item.textTransform).toBe('none');
    expect(item.letterSpacing).toBe('normal');
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
