/**
 * The Progressive Web App contract, in one place.
 *
 * The manifest, the service worker and the document metadata must agree on three
 * things — where the manifest lives, which script is the worker, and what the
 * browser chrome should be tinted — so they are declared once here instead of
 * being repeated as string literals in the layout, the worker registration and
 * the tests. The asset files themselves stay static under `public/`, which is
 * the only directory Next serves verbatim at the URLs recorded here.
 */

/** Public URL of the web app manifest. */
export const PWA_MANIFEST_PATH = "/manifest.json";

/** Public URL of the service worker script. */
export const SERVICE_WORKER_PATH = "/sw.js";

/** Public URL of the offline fallback document the worker precaches. */
export const PWA_OFFLINE_PATH = "/offline.html";

/** Must equal `theme_color` / `background_color` in `public/manifest.json`. */
export const PWA_THEME_COLOR = "#0a0d12";

// ── Deferred app-shell updates (#398, #399) ────────────────────────────────

/**
 * The message a page posts to a waiting worker to let it take over.
 *
 * The worker no longer calls `skipWaiting()` while installing: an update must
 * never replace the app under an operator mid-edit or mid-signature. Activation
 * happens only when a page sends this message, which the browser then follows
 * (`clients.claim()` in `activate`) with a single reload that the page owns.
 * `public/sw.js` compares against this exact literal; the unit test pins them
 * together so the two files cannot drift.
 */
export const SERVICE_WORKER_SKIP_WAITING_MESSAGE = "GUARD_SKIP_WAITING";

/** What kind of work would be lost if the shell were replaced right now. */
export type PwaActivityKind = "draft" | "write";

/** The live answer to "is it safe to activate an update right now?". */
export interface PwaActivity {
  /** An operator has unsaved policy or deployment edits. */
  draftDirty: boolean;
  /** Wallet approvals or writes currently in flight. */
  pendingWrites: number;
}

/** The only activity value when nothing is going on, shared so identity is stable. */
export const IDLE_PWA_ACTIVITY: PwaActivity = Object.freeze({
  draftDirty: false,
  pendingWrites: 0,
}) as PwaActivity;

/**
 * The activity registry, kept in a module store rather than React context.
 *
 * The service worker outlives any single panel, and the panels that can lose
 * work (policy form, deploy panel, panic panel) are not ancestors of the
 * registrar. A tiny store with `useSyncExternalStore` gives the registrar a
 * live answer without threading a callback through every component, and lets a
 * component register for exactly as long as its risky state is true.
 */
const activityOwners = new Map<string, PwaActivityKind>();
const activityListeners = new Set<() => void>();
let activitySequence = 0;
let activitySnapshot: PwaActivity = IDLE_PWA_ACTIVITY;

function recomputeActivity(): void {
  let draftDirty = false;
  let pendingWrites = 0;
  for (const kind of activityOwners.values()) {
    if (kind === "draft") draftDirty = true;
    else pendingWrites += 1;
  }
  activitySnapshot =
    draftDirty || pendingWrites > 0 ? { draftDirty, pendingWrites } : IDLE_PWA_ACTIVITY;
  for (const listener of activityListeners) listener();
}

/**
 * Declare that this component currently holds work an update would discard.
 * Returns an unsubscribe function; calling it more than once is a no-op.
 */
export function registerPwaActivity(kind: PwaActivityKind): () => void {
  activitySequence += 1;
  const id = `activity-${activitySequence}`;
  activityOwners.set(id, kind);
  recomputeActivity();
  return () => {
    if (activityOwners.delete(id)) recomputeActivity();
  };
}

/** The current activity, in a stable object while nothing changes. */
export function pwaActivitySnapshot(): PwaActivity {
  return activitySnapshot;
}

/** Subscribe to activity changes. Returns the unsubscribe function. */
export function subscribePwaActivity(listener: () => void): () => void {
  activityListeners.add(listener);
  return () => {
    activityListeners.delete(listener);
  };
}

/**
 * The whole update notice, as data.
 *
 * Kept out of the component so the three lifecycle cases the issue names —
 * idle, dirty draft, pending write — are testable without a browser or a real
 * service worker. `deferred` means the update is held back by operator work;
 * `canReload` stays true because the operator may always choose to discard it.
 */
export interface PwaUpdateView {
  /** Whether the notice should be shown at all. */
  visible: boolean;
  /** True while a draft or pending write holds the update back. */
  deferred: boolean;
  /** Why it is deferred, or null when the app is idle. */
  reason: "draft" | "pending-write" | null;
  /** The blocking condition, in the operator's terms. */
  title: string;
  detail: string;
  /** The explicit action's label. */
  reloadLabel: string;
}

export const PWA_UPDATE_AVAILABLE_TITLE = "A new version of the console is ready.";

/**
 * What the shell announces when an update starts waiting. Spoken through the
 * one announcement queue (`useAnnounce`) rather than a second live region, so it
 * inherits the queue's ordering and deduplication.
 */
export const PWA_UPDATE_ANNOUNCEMENT =
  "A new version of the console is ready. Reload when it is safe to do so.";

export function evaluatePwaUpdate(input: {
  updateAvailable: boolean;
  activity?: PwaActivity;
}): PwaUpdateView {
  if (!input.updateAvailable) {
    return {
      visible: false,
      deferred: false,
      reason: null,
      title: "",
      detail: "",
      reloadLabel: "",
    };
  }
  const activity = input.activity ?? IDLE_PWA_ACTIVITY;

  if (activity.pendingWrites > 0) {
    return {
      visible: true,
      deferred: true,
      reason: "pending-write",
      title: PWA_UPDATE_AVAILABLE_TITLE,
      detail:
        "The update is on hold while a wallet approval or write is in flight. Reload once it finishes: reloading now would interrupt the transaction, and nothing is replayed for you.",
      reloadLabel: "Reload anyway",
    };
  }

  if (activity.draftDirty) {
    return {
      visible: true,
      deferred: true,
      reason: "draft",
      title: PWA_UPDATE_AVAILABLE_TITLE,
      detail:
        "The update is on hold because you have unsaved policy or deployment edits. Reload when you are ready — reloading now discards the draft.",
      reloadLabel: "Reload and discard draft",
    };
  }

  return {
    visible: true,
    deferred: false,
    reason: null,
    title: PWA_UPDATE_AVAILABLE_TITLE,
    detail:
      "Reload to switch to the new app shell. Chain reads are always fetched live, so the update changes only the interface.",
    reloadLabel: "Reload now",
  };
}
