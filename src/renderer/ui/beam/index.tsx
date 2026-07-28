/**
 * `AppBeam` — the app's only entry point to the `border-beam` library.
 *
 * Nothing outside this folder imports `border-beam` directly. Call sites name a
 * role (`preset="panel-streaming"`) and get the tuning that goes with it; the
 * prop bag itself lives in `presets.ts`, which is pure and unit-tested, because
 * this file is React and the root vitest project (`environment: 'node'`) cannot
 * mount it. What is left here is exactly the part that needs a browser: reading
 * the current appearance mode out of context, and watching two media queries.
 *
 * The component renders `BorderBeam` and nothing else. Per AGENTS.md there are
 * no raw `<div>`s in this repo for layout — and there are none here either:
 * `BorderBeam` *is* the component, and wrapping it in a Stack to "position" it
 * would break the library's auto-detection of the child's border radius.
 */

import { useSyncExternalStore } from 'react';
import { BorderBeam, type BorderBeamProps } from 'border-beam';

import { useThemeMode } from '../../AppShell';
import { beamProps, resolveScheme, type BeamPreset } from './presets';

/** One import site for consumers: the dock takes both from here. */
export type { BeamPreset };
export { beamProps, resolveScheme } from './presets';

const PREFERS_DARK = '(prefers-color-scheme: dark)';
const PREFERS_REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

/**
 * A `useSyncExternalStore` adapter over one media query.
 *
 * Built once per query at module scope so the `subscribe`/`getSnapshot` pair is
 * referentially stable — passing freshly-created closures would make React tear
 * the listener down and set it up again on every render.
 *
 * `matchMedia` is absent in a node context. This module is renderer-only so
 * that should never happen, but returning `false` is cheaper than the crash and
 * degrades to "light scheme, motion allowed", which is the safe pair.
 */
function mediaStore(query: string): {
  subscribe: (onStoreChange: () => void) => () => void;
  getSnapshot: () => boolean;
} {
  const list =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query)
      : null;
  return {
    subscribe: (onStoreChange) => {
      list?.addEventListener('change', onStoreChange);
      return () => list?.removeEventListener('change', onStoreChange);
    },
    getSnapshot: () => list?.matches === true,
  };
}

const darkStore = mediaStore(PREFERS_DARK);
const reducedMotionStore = mediaStore(PREFERS_REDUCED_MOTION);

/**
 * `border-beam` needs CSS `@property`, i.e. Chrome 85+ / Safari 15.4+. Electron
 * 38 ships Chromium far past that and the browser preview targets modern
 * browsers, so no polyfill and no feature detection. This guard covers the
 * other failure mode instead — the import resolving to nothing at all, e.g. a
 * bundle that tree-shook it out or a partially-installed dependency. In that
 * case the children still have to render, unstyled, rather than the whole dock
 * dying on `<undefined>`.
 */
const Beam = BorderBeam as typeof BorderBeam | undefined;

export interface AppBeamProps {
  readonly preset: BeamPreset;
  readonly children: React.ReactNode;
  /** Defaults true. False stops the animation without unmounting. */
  readonly active?: boolean;
  /** Library API value in px, not a CSS literal. Omit to auto-detect the child's radius. */
  readonly borderRadius?: number;
  readonly className?: string;
  readonly style?: React.CSSProperties;
}

export function AppBeam({
  preset,
  children,
  active = true,
  borderRadius,
  className,
  style,
}: AppBeamProps): React.JSX.Element {
  const { mode } = useThemeMode();
  const prefersDark = useSyncExternalStore(darkStore.subscribe, darkStore.getSnapshot);
  const prefersReducedMotion = useSyncExternalStore(
    reducedMotionStore.subscribe,
    reducedMotionStore.getSnapshot,
  );

  // The annotation is the point: it is a compile-time proof that BeamPropBag is
  // assignable to BorderBeamProps minus `children`, so a library upgrade that
  // renames or retypes a prop fails `npm run typecheck` instead of silently
  // rendering the default beam.
  const resolved: Omit<BorderBeamProps, 'children'> = beamProps(
    preset,
    // A `system` user flipping their OS appearance updates live via the store
    // above; `light`/`dark` ignore the OS entirely, which is the whole reason
    // we never hand the library its own `theme="auto"`.
    resolveScheme(mode, prefersDark),
  );

  // Accessibility, not a preference: `prefers-reduced-motion` switches every
  // beam off. `active={false}` keeps the element mounted and its colours static
  // rather than yanking the border away, so layout does not shift.
  const isAnimating = active && !prefersReducedMotion;

  if (Beam === undefined) return <>{children}</>;

  return (
    <Beam {...resolved} active={isAnimating} borderRadius={borderRadius} className={className} style={style}>
      {children}
    </Beam>
  );
}
