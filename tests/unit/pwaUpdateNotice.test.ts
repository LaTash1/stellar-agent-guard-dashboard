import assert from "node:assert/strict";
import { afterEach, before, describe, test } from "node:test";
import { installDom, loadReact } from "./domHarness.ts";
import { PwaUpdateNotice } from "../../components/PwaRegistrar.tsx";
import { IDLE_PWA_ACTIVITY, evaluatePwaUpdate, type PwaUpdateView } from "../../lib/guard/pwa.ts";

/**
 * The update notice is the operator-facing half of #398: it has to be
 * non-blocking, say why an update is being held back, and give one explicit
 * action. Rendered here without a service worker so the three lifecycle cases
 * can be asserted directly.
 */
describe("PwaUpdateNotice", () => {
  let React: Awaited<ReturnType<typeof loadReact>>["react"];
  let createRoot: Awaited<ReturnType<typeof loadReact>>["createRoot"];
  let act: Awaited<ReturnType<typeof loadReact>>["act"];
  let root: ReturnType<typeof createRoot> | null = null;

  before(async () => {
    installDom();
    const reactDeps = await loadReact();
    React = reactDeps.react;
    createRoot = reactDeps.createRoot;
    act = reactDeps.act;
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root!.unmount();
      });
      root = null;
    }
    document.body.innerHTML = "";
  });

  async function render(
    view: PwaUpdateView,
    handlers: {
      confirming?: boolean;
      reloading?: boolean;
      onReload?: () => void;
      onKeepWorking?: () => void;
      onLater?: () => void;
    } = {},
  ): Promise<void> {
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(() => {
      root!.render(
        React.createElement(PwaUpdateNotice, {
          view,
          confirming: handlers.confirming ?? false,
          reloading: handlers.reloading ?? false,
          onReload: handlers.onReload ?? (() => {}),
          onKeepWorking: handlers.onKeepWorking ?? (() => {}),
          onLater: handlers.onLater ?? (() => {}),
        }),
      );
    });
  }

  function button(label: string): HTMLButtonElement {
    const match = Array.from(document.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.trim() === label,
    );
    assert.ok(match, `expected a "${label}" button, got: ${document.body.textContent}`);
    return match;
  }

  test("idle: a non-blocking notice with an explicit reload and a later action", async () => {
    await render(evaluatePwaUpdate({ updateAvailable: true, activity: IDLE_PWA_ACTIVITY }));

    // A region, not a dialog: it never traps focus or blocks the console.
    assert.ok(document.querySelector(".pwa-update[role='region']"));
    assert.equal(document.querySelector("[role='dialog']"), null);
    assert.equal(document.querySelector("[aria-modal='true']"), null);
    assert.match(document.body.textContent ?? "", /new version of the console is ready/i);
    button("Reload now");
    button("Later");
    assert.doesNotMatch(document.body.textContent ?? "", /Held back/);
  });

  test("dirty draft: the notice says the update is held back", async () => {
    let reloads = 0;
    await render(
      evaluatePwaUpdate({
        updateAvailable: true,
        activity: { draftDirty: true, pendingWrites: 0 },
      }),
      {
        onReload: () => {
          reloads += 1;
        },
      },
    );

    assert.match(document.body.textContent ?? "", /Held back: unsaved edits are open\./);
    assert.match(document.body.textContent ?? "", /discards the draft/i);
    const reload = button("Reload and discard draft");
    act(() => {
      reload.click();
    });
    assert.equal(reloads, 1, "the reload action stays explicit and available");
  });

  test("pending write: the notice names the in-flight write and warns about replay", async () => {
    await render(
      evaluatePwaUpdate({
        updateAvailable: true,
        activity: { draftDirty: false, pendingWrites: 1 },
      }),
    );
    assert.match(document.body.textContent ?? "", /Held back: a write is in flight\./);
    assert.match(document.body.textContent ?? "", /Nothing will be replayed|nothing is replayed/i);
    button("Reload anyway");
  });

  test("after the operator confirms, a second explicit action applies the update", async () => {
    let keepWorking = 0;
    await render(
      evaluatePwaUpdate({
        updateAvailable: true,
        activity: { draftDirty: true, pendingWrites: 0 },
      }),
      {
        confirming: true,
        onKeepWorking: () => {
          keepWorking += 1;
        },
      },
    );

    assert.match(
      document.body.textContent ?? "",
      /Confirmed: reloading now discards the unsaved draft\./,
    );
    button("Yes, reload now");
    const keep = button("Keep working");
    act(() => {
      keep.click();
    });
    assert.equal(keepWorking, 1);
  });

  test("renders nothing when no update is waiting", async () => {
    await render(evaluatePwaUpdate({ updateAvailable: false }));
    assert.equal(document.body.textContent?.trim() ?? "", "");
  });
});
