/**
 * Tracks whether the client form is still interested in the outcome of an
 * in-flight save. Once the dialog is dismissed (or the component unmounts),
 * a settling request must neither call onSaved nor write component state.
 * Kept free of React so it can run under the node vitest environment.
 */

export interface SaveGuard {
  /** Mark the dialog dismissed; later settlements are dropped. */
  dismiss(): void;
  /** Re-arm on mount so a StrictMode remount does not stay dismissed. */
  arm(): void;
  isDismissed(): boolean;
  /** Run the settlement handler only while the dialog is still live. */
  settle(handler: () => void): void;
}

export function createSaveGuard(): SaveGuard {
  let dismissed = false;
  return {
    dismiss(): void {
      dismissed = true;
    },
    arm(): void {
      dismissed = false;
    },
    isDismissed(): boolean {
      return dismissed;
    },
    settle(handler: () => void): void {
      if (!dismissed) {
        handler();
      }
    },
  };
}
