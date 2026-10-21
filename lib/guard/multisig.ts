/**
 * Multi-signature approval tracking for admin transactions.
 *
 * Enterprise deployments configure the guarded account with Stellar's native
 * multi-sig: several co-signers, each carrying a weight, and threshold values
 * (`med_threshold` for ordinary operations) that a transaction's collected
 * signature weight must meet before the network will accept it. An admin
 * transaction submitted by one signer therefore sits *pending* — included
 * nowhere, effective nowhere — until enough co-signers have signed the same
 * envelope.
 *
 * Everything in this module is pure arithmetic over data the Horizon account
 * endpoint and the transaction envelope already carry: it never signs, never
 * broadcasts, and never invents a signature. The tracker's job is to answer two
 * questions honestly — *is this envelope submittable yet?* and *how much more
 * weight does it need at each threshold?* — from the facts on the envelope and
 * the account.
 *
 * An answer that cannot be known is never guessed. If the account has signers
 * whose signatures cannot be identified from an envelope (hash, pre-auth and
 * signed-payload signers carry no Ed25519 hint), the collected weight is only a
 * lower bound, so the remaining weight is reported as `null` rather than as a
 * number that looks authoritative but may be wrong.
 *
 * Types here deliberately mirror the shapes Horizon returns
 * (`ServerApi.AccountRecordSigners`, `HorizonApi.AccountThresholds`) rather
 * than wrapping them, so a caller can pass Horizon's response straight in and
 * the test can build fixtures without a network.
 */

/** One signer of the guarded account, as Horizon's account endpoint reports it. */
export interface MultisigSigner {
  /** The `G…` account that can co-sign. */
  key: string;
  /** The weight this signer's signature contributes. 0 disables the signer. */
  weight: number;
  /**
   * The operator's name for the signer ("Admin 1", "Ops", …). Displayed in the
   * tracker so co-signers can be told apart without decoding strkeys.
   */
  label: string;
  /**
   * How this signer authorizes, from Horizon's `type` field.
   *
   * Only an `ed25519` signer's transaction signature carries a public-key hint
   * that can be matched to an account signer without the key itself. `hash`,
   * `preauth` and `signed_payload` signers can still satisfy a threshold on the
   * network, but their contribution is invisible to the tracker — which is why
   * their presence downgrades the remaining-weight answer to "unknown".
   * Absent for callers that only have key + weight (and therefore Ed25519).
   */
  kind?: SignerKind;
}

/** The signer kinds Horizon reports (`type` on the account signer record). */
export type SignerKind = "ed25519" | "hash" | "preauth" | "signed_payload" | "unknown";

/** The account's signature thresholds, as Horizon reports them. */
export interface MultisigThresholds {
  low_threshold: number;
  med_threshold: number;
  high_threshold: number;
}

/** The threshold levels an account carries. Admin writes use the medium one. */
export type ThresholdLevel = "low" | "med" | "high";

/** A signature present on a pending envelope. */
export interface EnvelopeSignature {
  /** The `G…` account that produced the signature. */
  signer: string;
}

/**
 * One threshold's state against the envelope's collected weight.
 *
 * The collected weight is the same for every level — signatures do not carry a
 * level — but the requirement and therefore the shortfall differ per level.
 */
export interface ThresholdProgress {
  level: ThresholdLevel;
  /** Weight this level requires. */
  requiredWeight: number;
  /** Weight the envelope has collected (an identical number at every level). */
  collectedWeight: number;
  /**
   * Additional weight needed to meet this level: `0` when met, a positive
   * number when it is short, and `null` when the account holds signer data the
   * tracker cannot fully attribute to envelope signatures.
   */
  remainingWeight: number | null;
  /** `true` when the collected weight meets this level's requirement. */
  met: boolean;
}

/**
 * The tracker's verdict on one pending envelope.
 *
 * `ready` is the only word for "the network will accept this now". A pending
 * state below threshold is *not* an error — it is the normal life of a
 * multisig transaction — so no failure semantics attach to it.
 */
export interface MultisigApprovalState {
  /** Total weight of the signatures actually on the envelope. */
  collectedWeight: number;
  /** The threshold this transaction must meet (see `thresholdLevel`). */
  requiredWeight: number;
  /** `true` only when `collectedWeight >= requiredWeight`. */
  ready: boolean;
  /** Per-signer status, in the account's signer order. */
  signers: SignerStatus[];
  /**
   * Extra weight the governing threshold still needs. `null` when the answer
   * cannot be stated from the available signer data; `0` when the envelope is
   * already over the line.
   */
  remainingWeight: number | null;
  /** Remaining weight at every threshold, low to high, from the same read. */
  thresholds: [ThresholdProgress, ThresholdProgress, ThresholdProgress];
  /**
   * `unknown` when some applicable signer data cannot be attributed to an
   * envelope signature (non-Ed25519 signers, or ambiguous hint matching).
   */
  coverage: "complete" | "unknown";
  /**
   * Positive-weight signers whose signature cannot be matched from an envelope
   * hint. Their signatures would still count on the network.
   */
  unattributableSigners: SignerStatus[];
  /** Signatures repeated on the envelope; counted once, listed for transparency. */
  duplicateSignatures: string[];
}

/** Where one signer stands on a pending envelope. */
export interface SignerStatus {
  key: string;
  label: string;
  weight: number;
  /** The signature status of this signer. */
  status: "signed" | "pending";
  /**
   * Weight this signer would add by signing, capped at the governing threshold:
   * once the requirement is met the surplus is not "needed" any more. `null`
   * when the signer has already signed.
   */
  weightNeeded: number | null;
  /** How the signer authorizes, when the account read reported it. */
  kind?: SignerKind;
}

/** Human-readable names for the threshold levels, shared by UI and summaries. */
export const THRESHOLD_LABELS: Record<ThresholdLevel, string> = {
  low: "Low threshold",
  med: "Medium threshold",
  high: "High threshold",
};

function isEd25519(signer: MultisigSigner): boolean {
  return signer.kind === undefined || signer.kind === "ed25519";
}

/**
 * Evaluate a pending envelope against the account's signers and thresholds.
 *
 * Rules:
 *  - A signature on the envelope counts only when it belongs to an *account
 *    signer* — a stray signature from a removed key contributes nothing, which
 *    is exactly what the network would decide.
 *  - A repeated signature is counted once. Duplicates are listed so an operator
 *    can see the envelope was signed more than once by the same key, but they do
 *    not inflate the collected weight.
 *  - Zero-weight signers exist on accounts but are disabled: they cannot add
 *    weight, so they are shown as pending with `weightNeeded: 0` rather than
 *    silently omitted.
 *  - The governing threshold defaults to `med_threshold` — the one ordinary
 *    admin operations (`set_policy`, `freeze`, `unfreeze`) are authorized
 *    against — and the remaining weight is also computed for `low` and `high`
 *    from the same signer configuration. A threshold of 0 means the source
 *    account alone suffices.
 *  - Non-Ed25519 signers with weight cannot be matched from the envelope's
 *    4-byte signature hints. As soon as one exists (or the caller reports
 *    ambiguous hint matching), the remaining weight is `null` unless the
 *    collected lower bound already meets the threshold.
 */
export function evaluateApprovalState(params: {
  signers: readonly MultisigSigner[];
  thresholds: MultisigThresholds;
  signatures: readonly EnvelopeSignature[];
  /** Which threshold governs. Admin writes are medium-threshold operations. */
  thresholdLevel?: ThresholdLevel;
  /**
   * `false` when the caller could not attribute every envelope signature to
   * exactly one account signer (for example two signers share a 4-byte hint).
   * Defaults to `true`; a caller that knows matching was ambiguous must say so.
   */
  signatureDataComplete?: boolean;
}): MultisigApprovalState {
  const { signers: accountSigners, thresholds, signatures } = params;
  const level = params.thresholdLevel ?? "med";

  // Count each signer once, no matter how many times the envelope carries their
  // signature. Removing from the set as we walk the account signers also makes
  // a signature from a removed key contribute nothing.
  const signedKeys = new Set<string>();
  const duplicateSignatures: string[] = [];
  for (const signature of signatures) {
    if (signedKeys.has(signature.signer)) {
      if (!duplicateSignatures.includes(signature.signer)) {
        duplicateSignatures.push(signature.signer);
      }
      continue;
    }
    signedKeys.add(signature.signer);
  }

  let collectedWeight = 0;
  for (const signer of accountSigners) {
    if (signedKeys.has(signer.key) && signer.weight > 0) {
      collectedWeight += signer.weight;
    }
  }

  const unattributable = accountSigners.filter((signer) => signer.weight > 0 && !isEd25519(signer));
  const coverage =
    (params.signatureDataComplete ?? true) && unattributable.length === 0 ? "complete" : "unknown";

  const remainingFor = (requiredWeight: number): number | null => {
    const missing = Math.max(0, requiredWeight - collectedWeight);
    if (missing === 0) return 0;
    return coverage === "complete" ? missing : null;
  };

  const thresholdProgress = (["low", "med", "high"] as const).map((thresholdLevel) => {
    const requiredWeight =
      thresholdLevel === "low"
        ? thresholds.low_threshold
        : thresholdLevel === "high"
          ? thresholds.high_threshold
          : thresholds.med_threshold;
    return {
      level: thresholdLevel,
      requiredWeight,
      collectedWeight,
      remainingWeight: remainingFor(requiredWeight),
      met: collectedWeight >= requiredWeight,
    };
  }) as [ThresholdProgress, ThresholdProgress, ThresholdProgress];

  const requiredWeight =
    level === "low"
      ? thresholds.low_threshold
      : level === "high"
        ? thresholds.high_threshold
        : thresholds.med_threshold;

  // Build statuses only after the total is known, so every pending signer sees
  // the same shortfall rather than the partial total accumulated so far.
  const signers: SignerStatus[] = accountSigners.map((signer) => {
    const signed = signedKeys.has(signer.key);
    const base = {
      key: signer.key,
      label: signer.label,
      weight: signer.weight,
      ...(signer.kind === undefined ? {} : { kind: signer.kind }),
    };
    if (signed && signer.weight > 0) {
      return { ...base, status: "signed", weightNeeded: null };
    }
    const shortfall = Math.max(0, requiredWeight - collectedWeight);
    return {
      ...base,
      status: signed ? "signed" : "pending",
      // A disabled (weight-0) signer cannot help reach the threshold.
      weightNeeded: signer.weight > 0 ? Math.min(signer.weight, shortfall) : 0,
    };
  });

  const unattributableSigners = signers.filter((signer) =>
    unattributable.some((accountSigner) => accountSigner.key === signer.key),
  );

  return {
    collectedWeight,
    requiredWeight,
    ready: requiredWeight > 0 ? collectedWeight >= requiredWeight : true,
    signers,
    remainingWeight: remainingFor(requiredWeight),
    thresholds: thresholdProgress,
    coverage,
    unattributableSigners,
    duplicateSignatures,
  };
}

/**
 * Who still needs to sign, in the order that reaches the threshold soonest.
 *
 * Returned as signer keys so the UI can render "waiting on" without re-deriving
 * it, and capped at exactly the signers whose signature could still move the
 * envelope towards the threshold.
 */
export function pendingSigners(state: MultisigApprovalState): string[] {
  if (state.ready) return [];
  let remaining = state.requiredWeight - state.collectedWeight;
  const waiting: string[] = [];
  for (const signer of state.signers) {
    if (remaining <= 0) break;
    if (signer.status === "pending" && signer.weight > 0) {
      waiting.push(signer.key);
      remaining -= signer.weight;
    }
  }
  return waiting;
}

/** The canonical summary line the tracker displays. */
export function approvalSummary(state: MultisigApprovalState): string {
  const who = state.signers
    .map((signer) => `${signer.label} [${signer.status === "signed" ? "Signed" : "Pending"}]`)
    .join(", ");
  return `Collected weight ${state.collectedWeight} of ${state.requiredWeight} required (${who})`;
}

/**
 * The one-line statement of what is still missing, for the tracker and the
 * screen-reader announcement.
 *
 * Deliberately never renders `null` as `0`: an unknown shortfall is described
 * as unknown, naming the signer data that prevents an exact figure.
 */
export function remainingWeightSummary(state: MultisigApprovalState): string {
  const governing = THRESHOLD_LABELS.med;
  if (state.remainingWeight === null) {
    const count = state.unattributableSigners.length;
    const detail =
      count > 0
        ? `${count} signer${count === 1 ? "" : "s"} of a type that cannot be matched from envelope signatures`
        : "the envelope signatures could not be matched unambiguously to account signers";
    return `Remaining weight at the ${governing.toLowerCase()} is unknown: ${detail}.`;
  }
  if (state.remainingWeight === 0) {
    return `No further signer weight is required at the ${governing.toLowerCase()}.`;
  }
  return `${state.remainingWeight} more signer weight is required at the ${governing.toLowerCase()}.`;
}

/**
 * The share of the threshold collected, as 0–100 for a progress bar.
 *
 * The ceiling is the threshold, not the account's total weight: extra surplus
 * signatures should not read as "more than done". A threshold of 0 is complete
 * by definition and returns 100.
 */
export function approvalPercent(state: MultisigApprovalState): number {
  if (state.requiredWeight <= 0) return 100;
  return Math.min(100, Math.round((state.collectedWeight / state.requiredWeight) * 100));
}
