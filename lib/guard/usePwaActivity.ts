"use client";

import { useEffect } from "react";
import { registerPwaActivity, type PwaActivityKind } from "./pwa.ts";

/**
 * Hold app-shell updates back for as long as `active` is true.
 *
 * Mounted by the panels that can lose work to a reload — an edited policy
 * draft, a deploy in progress, a freeze awaiting the wallet. The registration
 * is keyed to the boolean, so a panel that stops editing releases the hold
 * immediately and the next update can activate without a page reload.
 *
 * This is a *deferral*, not a lock: the operator can still choose to reload
 * from the update notice, and the notice says what that will discard.
 */
export function usePwaActivity(active: boolean, kind: PwaActivityKind = "draft"): void {
  useEffect(() => {
    if (!active) return;
    return registerPwaActivity(kind);
  }, [active, kind]);
}
