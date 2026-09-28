/**
 * Telemetry: the guard's own events, from the two places they can exist.
 *
 * The part that is easy to get wrong, and which this module is shaped around: a
 * refused decision never reaches the ledger. The guard returns `Err`, which rolls
 * the event back, so a listener that only tails committed ledger events sees a
 * contract that appears to approve everything. The two sources are:
 *
 *   1. **ledger events** — allowed decisions, heartbeats, and the admin lifecycle
 *      events, tailed from `getEvents` with a cursor
 *      (`GuardTelemetryListener`, from the SDK).
 *   2. **simulation diagnostics** — refused decisions, which by construction have
 *      no transaction. The only place these arise in this dashboard is a write the
 *      operator attempted and the enforced simulation refused; the SDK's
 *      `guardEventsFromDiagnostics` decodes exactly those, and they are labelled
 *      `diagnostic` in the feed so they are never mistaken for settled history.
 *
 * "Real time" here means cursor-based polling of `getEvents`, because Soroban RPC
 * offers no push stream. The floor on latency is the ledger close interval, so
 * the feed reports the latest ledger it has seen rather than implying it is
 * instantaneous.
 */

import { GuardTelemetryListener, guardEventsFromDiagnostics } from "stellar-agent-guard-sdk";
import type { GuardEvent } from "stellar-agent-guard-sdk";
import type { rpc } from "@stellar/stellar-sdk";
import { NETWORK } from "./network.ts";

export interface TelemetryPage {
  events: GuardEvent[];
  cursor: string;
  latestLedger: number;
}

/**
 * A cursor-carrying reader over one guard's event stream.
 *
 * The cursor is held here rather than re-derived from a ledger number on every
 * poll, because `getEvents` pagination is only stable while a cursor is carried
 * forward — re-scanning from a ledger can miss events that fell outside the
 * window between polls.
 */
/**
 * Note the explicit field declarations rather than constructor parameter
 * properties: this module is loaded by `node --test` and by the proof script
 * through Node's type-stripping loader, which rejects parameter properties
 * outright. Keeping the whole library strippable means the browser, the test
 * runner and the proof script execute the same source rather than three builds
 * of it.
 */
export class GuardFeed {
  readonly guard: string;
  private readonly listener: GuardTelemetryListener;
  private cursor: string | null = null;
  private latestLedger: number | null = null;

  constructor(server: rpc.Server, guard: string, rpcUrl: string = NETWORK.rpcUrl) {
    this.guard = guard;
    this.listener = new GuardTelemetryListener({ server, guard, rpcUrl });
  }

  /** One page of committed ledger events. Advances the cursor. */
  async pollOnce(limit = 50): Promise<TelemetryPage> {
    const params: { cursor?: string; limit: number; startLedger?: number } = { limit };
    if (this.cursor) {
      params.cursor = this.cursor;
    } else if (this.latestLedger !== null) {
      params.startLedger = this.latestLedger;
    }
    const page = await this.listener.poll(params);
    // A page with no events still advances the ledger pointer, so the next poll
    // does not re-scan a stretch of empty ledgers.
    this.latestLedger = Math.max(this.latestLedger ?? 0, page.latestLedger);
    if (page.cursor) this.cursor = page.cursor;
    return page;
  }

  /** Where the feed currently is, for display. */
  position(): { cursor: string | null; latestLedger: number | null } {
    return { cursor: this.cursor, latestLedger: this.latestLedger };
  }

  /** Forget the cursor so the feed re-scans from a given ledger. */
  resetFrom(ledger: number | null): void {
    this.cursor = null;
    this.latestLedger = ledger;
  }
}

/** The slice of `GuardFeed` a coordinator drives. `GuardFeed` satisfies it structurally. */
export interface PolledFeed {
  readonly guard: string;
  pollOnce(limit?: number): Promise<TelemetryPage>;
  position(): { cursor: string | null; latestLedger: number | null };
  resetFrom(ledger: number | null): void;
}

/**
 * How far back a freshly-switched-to feed asks for history, in ledgers.
 *
 * A guard switch must land with context, not a blank page: the SDK's own
 * default for an unprimed feed is "start at the current head" (its comment:
 * replaying a year of history by accident is a mean surprise), which is right
 * for a first watch but wrong for an operator arriving from another guard —
 * they expect to see what the guard has been doing lately. Priming a new feed
 * with `latestKnown − FEED_SWITCH_HISTORY_LEDGERS` asks for roughly the last
 * five minutes (at ~5s ledger closes) without ever replaying a year. Ledgers
 * are chain-global, so the currently-known head is valid across guards.
 */
export const FEED_SWITCH_HISTORY_LEDGERS = 60;

export interface FeedCoordinatorStats {
  /** Feeds constructed since this coordinator existed. */
  created: number;
  /** Feeds replaced because the operator switched identity — each held a cursor
   * that must never be resumed onto another guard's stream. */
  abandoned: number;
}

/**
 * Exactly one live feed per guard identity, and a fresh cursor on every change.
 *
 * Guard switches are where feed data isolation can silently fail: a feed built
 * for guard A carries A's cursor, and resuming that cursor under guard B would
 * tail B's stream from a position that meant something on A — wrong-attribution
 * incidents waiting to happen. The rule is deliberately blunt: a different
 * guard id means a new `GuardFeed` with a null cursor, and the old feed is
 * abandoned, never resumed. A rapid A→B→A therefore lands on a *fresh* A stream,
 * not A's stale position (the deferred-init race dies here, synchronously, by
 * identity check). Counting is exposed so tests can prove abandonment.
 */
export class GuardFeedCoordinator {
  private feed: PolledFeed | null = null;
  private readonly stats: FeedCoordinatorStats = { created: 0, abandoned: 0 };
  private readonly factory: (guard: string) => PolledFeed;

  constructor(factory: (guard: string) => PolledFeed) {
    this.factory = factory;
  }

  /** The feed for `guard`: reused when identity matches, replaced when it does not. */
  ensure(guard: string): PolledFeed {
    if (this.feed && this.feed.guard === guard) return this.feed;
    if (this.feed) this.stats.abandoned += 1;
    this.feed = this.factory(guard);
    this.stats.created += 1;
    return this.feed;
  }

  /** The live feed, if one exists. Callers poll through this, never a cached ref. */
  current(): PolledFeed | null {
    return this.feed;
  }

  statsSnapshot(): FeedCoordinatorStats {
    return { ...this.stats };
  }
}

/**
 * Decode refused-decision events out of an attempted write's diagnostics.
 *
 * These are the only refused decisions this interface can ever see, and they are
 * returned with `source: "diagnostic"` so the feed can say plainly that they were
 * never committed — a distinction that matters, because a rolled-back event is
 * evidence of a refusal, not of settled state.
 */
export function refusedEventsFromDiagnostics(
  diagnosticEvents: readonly unknown[],
  guard: string,
): GuardEvent[] {
  return guardEventsFromDiagnostics(diagnosticEvents, guard);
}
