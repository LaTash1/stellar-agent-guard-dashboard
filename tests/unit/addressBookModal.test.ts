/**
 * The address-book modal, exercised through its real UI (issues #376, #377).
 *
 * The pure logic is covered in `addressBook.test.ts`; these tests drive the
 * component the operator actually uses, so a regression in the wiring — a
 * conflict that no longer blocks the save, a preview that writes before the
 * operator confirms, a resolution button that applies the wrong outcome — fails
 * here rather than only in a unit of arithmetic.
 */

import assert from "node:assert/strict";
import { afterEach, before, test } from "node:test";
import { installDom, loadReact, sleep, type Act } from "./domHarness.ts";
import { AddressBookModal } from "../../components/AddressBookModal.tsx";
import {
  ADDRESS_BOOK_EXPORT_SCHEMA,
  lookupLabel,
  saveContact,
} from "../../lib/guard/addressBook.ts";

installDom();

let react: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let act: Act;
let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLElement;

const ACCOUNT = "GDQAPKMAI3WA6H4TDLAWUM6BCQOB22SCQIQWQMLWAHTDRWOVYCXRCVTK";
const CONTRACT = "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44";
const OTHER = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";

before(async () => {
  const loaded = await loadReact();
  react = loaded.react;
  createRoot = loaded.createRoot;
  act = loaded.act;
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
    root = null;
  }
  document.body.innerHTML = "";
  window.localStorage.clear();
});

async function renderModal(): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(react.createElement(AddressBookModal, { onClose: () => {} }));
    await sleep(0);
  });
  return container;
}

function buttonByText(scope: HTMLElement, text: string): HTMLButtonElement {
  const button = [...scope.querySelectorAll("button")].find((candidate) =>
    (candidate.textContent ?? "").includes(text),
  );
  assert.ok(
    button,
    `expected a button containing "${text}", got: ${[...scope.querySelectorAll("button")]
      .map((candidate) => candidate.textContent)
      .join(" | ")}`,
  );
  return button as HTMLButtonElement;
}

async function click(scope: HTMLElement, text: string): Promise<void> {
  const button = buttonByText(scope, text);
  await act(async () => {
    button.click();
    await sleep(0);
  });
}

async function typeInto(input: HTMLInputElement, text: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, text);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    await sleep(0);
  });
}

async function fillEditor(scope: HTMLElement, address: string, label: string): Promise<void> {
  const addressInput = scope.querySelector<HTMLInputElement>('[aria-label="Contact address"]');
  const labelInput = scope.querySelector<HTMLInputElement>('[aria-label="Contact nickname"]');
  assert.ok(addressInput && labelInput, "the editor inputs must render");
  await typeInto(addressInput, address);
  await typeInto(labelInput, label);
}

test("deleting a contact removes it from the list and from storage", async () => {
  saveContact({ address: ACCOUNT, label: "Treasury" }, window.localStorage);
  const scope = await renderModal();
  assert.match(scope.textContent ?? "", /Treasury/);

  await click(scope, "Delete");
  assert.equal(lookupLabel(ACCOUNT, window.localStorage), null);
  assert.match(scope.textContent ?? "", /No contacts yet/);
});

test("a duplicate address stops at a visible conflict and only updates after confirmation", async () => {
  saveContact({ address: ACCOUNT, label: "Treasury" }, window.localStorage);
  const scope = await renderModal();

  await fillEditor(scope, ACCOUNT, "Ops Treasury");
  await click(scope, "Update contact");

  assert.match(scope.textContent ?? "", /That address is already saved/);
  assert.equal(lookupLabel(ACCOUNT, window.localStorage), "Treasury", "nothing was written yet");

  await click(scope, "Update label");
  assert.equal(lookupLabel(ACCOUNT, window.localStorage), "Ops Treasury");
  assert.match(scope.textContent ?? "", /Updated .*Ops Treasury/);
});

test("an alias conflict offers rename, update and cancel, and rename keeps the old holder", async () => {
  saveContact({ address: ACCOUNT, label: "Treasury" }, window.localStorage);
  const scope = await renderModal();

  await fillEditor(scope, OTHER, "  treasury  ");
  await click(scope, "Add contact");

  assert.match(scope.textContent ?? "", /That alias is already in use/);
  assert.match(scope.textContent ?? "", /belongs to/);
  assert.equal(lookupLabel(OTHER, window.localStorage), null, "the conflict blocked the save");

  const rename = buttonByText(scope, "Rename to");
  assert.match(rename.textContent ?? "", /treasury \(2\)/);
  await click(scope, "Rename to");

  assert.equal(lookupLabel(ACCOUNT, window.localStorage), "Treasury", "the holder is untouched");
  assert.equal(lookupLabel(OTHER, window.localStorage), "treasury (2)");
});

test("cancelling a conflict leaves the existing entry exactly as it was", async () => {
  saveContact({ address: ACCOUNT, label: "Treasury" }, window.localStorage);
  const scope = await renderModal();

  await fillEditor(scope, OTHER, "Treasury");
  await click(scope, "Add contact");
  assert.match(scope.textContent ?? "", /That alias is already in use/);

  await click(scope, "Cancel");
  assert.equal(lookupLabel(ACCOUNT, window.localStorage), "Treasury");
  assert.equal(lookupLabel(OTHER, window.localStorage), null);
  assert.match(scope.textContent ?? "", /No changes were made/);
});

test("an import is previewed before merge, and confirming merge writes only clean records", async () => {
  saveContact({ address: ACCOUNT, label: "Treasury" }, window.localStorage);
  const scope = await renderModal();

  const fileInput = scope.querySelector<HTMLInputElement>('input[type="file"]');
  assert.ok(fileInput, "the import input must render");
  const file = new window.File(
    [
      JSON.stringify({
        schema: ADDRESS_BOOK_EXPORT_SCHEMA,
        version: 1,
        exportedAt: "2026-10-20T00:00:00.000Z",
        contacts: [
          { address: OTHER, label: "Cold Wallet" },
          { address: "not-an-address", label: "Broken" },
        ],
      }),
    ],
    "address-book.json",
    { type: "application/json" },
  );

  await act(async () => {
    Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
    fileInput.dispatchEvent(new window.Event("change", { bubbles: true }));
    await sleep(30);
  });

  assert.match(scope.textContent ?? "", /Import preview/);
  assert.match(scope.textContent ?? "", /Nothing has been imported/);
  assert.match(scope.textContent ?? "", /Invalid/);
  assert.equal(lookupLabel(OTHER, window.localStorage), null, "previewing must not write");

  await click(scope, "Merge 1 contact(s)");
  assert.match(scope.textContent ?? "", /Add 1 contact\(s\) and keep the 1 already saved/);
  assert.equal(lookupLabel(OTHER, window.localStorage), null, "confirm step writes nothing yet");

  await click(scope, "Confirm merge");
  assert.equal(lookupLabel(ACCOUNT, window.localStorage), "Treasury");
  assert.equal(lookupLabel(OTHER, window.localStorage), "Cold Wallet");
  assert.match(scope.textContent ?? "", /Merged 1 contact\(s\) into the book/);
  assert.match(scope.textContent ?? "", /Cold Wallet/, "the list refreshes after the write");
});

test("a replace requires confirmation and reports what it removes", async () => {
  saveContact({ address: ACCOUNT, label: "Treasury" }, window.localStorage);
  saveContact({ address: CONTRACT, label: "Router" }, window.localStorage);
  const scope = await renderModal();

  const fileInput = scope.querySelector<HTMLInputElement>('input[type="file"]');
  assert.ok(fileInput);
  const file = new window.File(
    [JSON.stringify([{ address: OTHER, label: "Cold Wallet" }])],
    "legacy.json",
    { type: "application/json" },
  );
  await act(async () => {
    Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
    fileInput.dispatchEvent(new window.Event("change", { bubbles: true }));
    await sleep(30);
  });

  assert.match(scope.textContent ?? "", /legacy/i);
  await click(scope, "Replace book with 1");
  assert.match(scope.textContent ?? "", /Replace all 2 local contact\(s\)/);

  await click(scope, "Confirm replace");
  assert.equal(lookupLabel(OTHER, window.localStorage), "Cold Wallet");
  assert.equal(lookupLabel(ACCOUNT, window.localStorage), null);
  assert.equal(lookupLabel(CONTRACT, window.localStorage), null);
  assert.match(scope.textContent ?? "", /Replaced the book with 1 imported contact/);
});
