/**
 * Border-beam presets, as pure functions.
 *
 * `index.tsx` is a React file the test runner cannot mount — the root vitest
 * project is `environment: 'node'` and there is no DOM harness. Every decision
 * the adapter makes (which beam a surface gets, how fast it moves, how loud it
 * is, which colour scheme it renders against) therefore lives here, free of
 * React and of the `border-beam` runtime, so it can be unit-tested directly.
 * The only dependency on the library is `import type`, which is erased.
 *
 * The six presets between them cover every `BorderBeamColorVariant` and every
 * `BorderBeamSize` *except one*. That is a deliberate product requirement, not
 * an accident of taste, and `__tests__/presets.test.ts` guards it from both
 * sides: drop a variant and the runtime exhaustiveness test fails, while a
 * `border-beam` upgrade that *adds* a size or variant fails `npm run typecheck`
 * there, so a newly-shipped element cannot go quietly uncovered.
 *
 * The exception is `pulse-outside`, and it is excluded by geometry rather than
 * by taste. It is the only size whose layers have negative insets — a bloom at
 * `inset: -30px` — so it silently enlarges whatever wears it by 30px on every
 * side. Nothing in this app has that much room: the launcher is in a 36px
 * chrome band, the composer and the approval card are inside the dock panel's
 * card and its message scroller, and the panel's own two states are the app's
 * "is it thinking" signal, which is a travelling border rather than a breath.
 * An unused size is the honest outcome; the test says so out loud, so a preset
 * that reaches for it later has to argue with a failing assertion first.
 */

import type { BorderBeamColorVariant, BorderBeamSize } from 'border-beam';
import type { ThemeMode } from '../../../shared/types';

/**
 * A surface that can wear a beam. Named after the role, not the look, so the
 * dock can ask for `panel-streaming` without knowing it resolves to a colourful
 * `md` border — retuning a preset never touches a call site.
 */
export type BeamPreset =
  | 'launcher-idle'
  | 'launcher-attention'
  | 'panel-streaming'
  | 'panel-idle'
  | 'composer-focus'
  | 'approval-pending';

/** A concrete colour scheme. `ThemeMode`'s `'system'` has already been resolved. */
export type BeamScheme = 'light' | 'dark';

/**
 * The prop bag handed to `BorderBeam`. Structurally a subset of
 * `BorderBeamProps` minus `children`; `index.tsx` proves that with a
 * compile-time assignment so a library upgrade that renames a prop fails
 * `npm run typecheck` here rather than rendering wrong at runtime.
 */
export interface BeamPropBag {
  readonly size: BorderBeamSize;
  readonly colorVariant: BorderBeamColorVariant;
  /**
   * Always the resolved `'light' | 'dark'`, never the library's `'auto'`.
   * `'auto'` reads `prefers-color-scheme` directly, which is wrong here: the
   * app has an explicit three-way appearance control (`ThemeMode`), so a user
   * who forced Light on a dark OS would get a dark-tuned beam on a light
   * surface. `resolveScheme` is what closes that gap — it consults the OS
   * preference only when the user's own choice is `'system'`.
   */
  readonly theme: BeamScheme;
  /** 0–1. Opacity of the beam/glow layers only; children are unaffected. */
  readonly strength: number;
  /** Seconds per rotation (rotate family) or per breath (pulse family). */
  readonly duration: number;
  /**
   * Freezes the hue-shift animation. Set on the monochrome presets, where a
   * drifting hue is either invisible or, worse, a grey that faintly tints.
   */
  readonly staticColors?: boolean;
}

/**
 * Resolves the app's appearance setting to a concrete scheme.
 *
 * `prefersDark` is passed in rather than read from `matchMedia` so this stays
 * node-testable; `index.tsx` owns the subscription to the media query.
 */
export function resolveScheme(mode: ThemeMode, prefersDark: boolean): BeamScheme {
  if (mode === 'light') return 'light';
  if (mode === 'dark') return 'dark';
  return prefersDark ? 'dark' : 'light';
}

/**
 * Per-preset tuning, scheme-independent. `theme` is injected by `beamProps`.
 *
 * On the numbers. This is a desktop app someone stares at for a whole working
 * day, and an always-on animation in their peripheral vision is the fastest way
 * to make an assistant feel like an advert. So the rule is: motion is a signal,
 * and the amount of motion tracks how much the user is expected to care.
 *
 * - Ambient states (`launcher-idle`, `panel-idle`) are slower than the
 *   library's 2.3s default breath and sit under 0.3 strength. They should read
 *   as "the thing is alive" from the corner of an eye and as nothing at all
 *   when looked at straight on.
 * - Focus and attention states sit in the middle: fast enough to have been
 *   caused by something the user did, quiet enough to ignore.
 * - `panel-streaming` is the one loud preset. It runs while tokens arrive, it
 *   is short-lived by construction, and it is the app's answer to "is it stuck
 *   or is it thinking" — so it gets the library's native rotate speed and near
 *   full strength.
 */
const PRESETS: Record<BeamPreset, Omit<BeamPropBag, 'theme'>> = {
  /*
    Closed launcher at rest. Twice the default breath, barely there: this one is
    on screen permanently.

    `pulse-inner`, not `pulse-outside`, and that is geometry rather than taste.
    The launcher used to be a 44px bubble floating in the window's bottom-right
    corner, where an uncropped halo had 20px of clearance on two sides and
    nothing to overflow. It now sits at the inline end of the 36px breadcrumb
    band (see `ui/AssistantDock.tsx` for why), and `pulse-outside` is the one
    size in the library with negative insets: its bloom layer is
    `position: absolute; inset: -30px`, i.e. 30px of blurred halo in every
    direction around a 28px button. Sixteen of those pixels are the shell
    gutter; the other twelve hung past the content box and gave *every route* a
    horizontal scrollbar (`.astryx-layout-content` scrollWidth 1196 against
    clientWidth 1184 at 1440, and the same 12px at every width).

    Clipping it was the alternative and it is not one: 30px of glow in a 36px
    band has to be cut on three sides, and a hard rectangular edge through a
    blur reads as a rendering fault. Every other size is `inset: 0` — contained
    in the element's own box — so this is the version that cannot overflow
    anything, in either theme, in either frame.
  */
  'launcher-idle': {
    size: 'pulse-inner',
    colorVariant: 'mono',
    strength: 0.24,
    duration: 4.6,
    staticColors: true,
  },
  // Launcher with an unread reply or a pending approval. The same contained
  // breathe as at rest, so the change is a fill rather than a bigger halo — a
  // size change reads as a layout bug, and in a 36px band a bigger halo is one.
  // Ocean at more than twice the strength, at nearly half the period, carries
  // the whole difference between "alive" and "answer me".
  'launcher-attention': {
    size: 'pulse-inner',
    colorVariant: 'ocean',
    strength: 0.55,
    duration: 2.6,
  },
  // Model is streaming. Library-native rotate speed, near full strength.
  'panel-streaming': {
    size: 'md',
    colorVariant: 'colorful',
    strength: 0.85,
    duration: 1.96,
  },
  // Open panel, nothing happening. A hairline on the bottom edge only, at the
  // slowest travel in the set — the panel already has the user's attention and
  // does not need to keep asking for it.
  'panel-idle': {
    size: 'line',
    colorVariant: 'mono',
    strength: 0.2,
    duration: 6,
    staticColors: true,
  },
  // Composer focused. Compact glow scaled for an input, warm enough to mark
  // where the caret is without competing with the text being typed into it.
  'composer-focus': {
    size: 'sm',
    colorVariant: 'sunset',
    strength: 0.45,
    duration: 3.2,
  },
  // A mutating tool call waiting on Approve/Reject. Same warm palette as the
  // composer because both are "the user must act", at card size and stronger:
  // this is the one state where missing the beam has a consequence.
  'approval-pending': {
    size: 'md',
    colorVariant: 'sunset',
    strength: 0.7,
    duration: 2.4,
  },
};

/** Full `BorderBeam` prop bag for a preset at a given scheme. */
export function beamProps(preset: BeamPreset, scheme: BeamScheme): BeamPropBag {
  return { ...PRESETS[preset], theme: scheme };
}

/** Every preset, for exhaustiveness tests and for consumers that enumerate. */
export const BEAM_PRESETS: readonly BeamPreset[] = Object.keys(PRESETS) as BeamPreset[];
