import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/**
 * The air-gapped multisig guide (#375) is an operational document: an operator
 * follows it with real funds and real co-signers. These tests are the drift
 * guard for the promises it makes — network verification, partial signatures,
 * the no-secret-key statement, and recovery for every failure mode the issues
 * call out. If a section is removed, the test fails rather than leaving a
 * silently incomplete runbook.
 */
const GUIDE_PATH = "docs/guides/air-gapped-multisig-signing.md";

function guide(): string {
  return readFileSync(GUIDE_PATH, "utf8");
}

test("the guide walks the complete round trip in order", () => {
  const content = guide();
  const sections = [
    "Verify the network",
    "Build and export the unsigned envelope",
    "Hand off safely",
    "Collect partial signatures",
    "Check collected and remaining weight",
    "Import, review and submit",
    "Confirm inclusion",
    "Recovery playbook",
  ];
  let cursor = -1;
  for (const section of sections) {
    const found = content.indexOf(section, cursor + 1);
    assert.notEqual(found, -1, `missing guide section: ${section}`);
    assert.ok(found > cursor, `guide section out of order: ${section}`);
    cursor = found;
  }
});

test("the guide explains network verification, XDR handling and partial signatures", () => {
  const content = guide();
  assert.match(content, /network passphrase/i);
  assert.match(content, /Test SDF Network ; September 2015/);
  assert.match(content, /checksum|sha256sum/i, "XDR files are verified before hand-off");
  assert.match(content, /partially signed envelope/i);
  assert.match(content, /append/i, "signing is additive, not a rebuild");
  assert.match(content, /adding a signature does not change the transaction hash/i);
});

test("the guide states the client-only, non-custodial boundary explicitly", () => {
  const content = guide();
  assert.match(content, /never needs[^.]*secret key/is);
  assert.match(content, /non-custodial/i);
  assert.match(content, /client-only/i);
  assert.match(content, /no API route/i);
  assert.match(content, /no secret-key persistence/i);
});

test("the guide covers remaining weight, including the unknown case", () => {
  const content = guide();
  assert.match(content, /remaining signer weight/i);
  assert.match(content, /more weight required/i);
  assert.match(content, /unknown — signer data could not be fully matched/i);
  assert.match(content, /what "enough" means depends on \*\*weight\*\*, not signature count/i);
});

test("the guide has recovery steps for every failure mode in the issue", () => {
  const content = guide();
  // Stale sequence
  assert.match(content, /tx_bad_seq/);
  // Expiration / time bounds
  assert.match(content, /tx_too_late/);
  assert.match(content, /tx_too_early/);
  // Incompatible envelopes
  assert.match(content, /incompatible envelope/i);
  assert.match(content, /fee-bump/i);
  // Rejected transactions, including on-chain policy rejection
  assert.match(content, /tx_bad_auth/);
  assert.match(content, /contract error/i);
  assert.match(content, /SUCCESS.*FAILED|FAILED.*SUCCESS/is);
});

test("the final submit review is an explicit checklist", () => {
  const content = guide();
  assert.match(content, /final review/i);
  assert.match(content, /Ready to submit/i);
  assert.match(content, /Submit to Network/);
  // Every item is a checkbox the operator can tick.
  const checks = content.match(/^- \[ \] /gm) ?? [];
  assert.ok(checks.length >= 5, `expected a review checklist, found ${checks.length} items`);
});

test("the guide is discoverable from SUMMARY and the README", () => {
  const summary = readFileSync("docs/SUMMARY.md", "utf8");
  assert.match(summary, /\(guides\/air-gapped-multisig-signing\.md\)/);
  const readme = readFileSync("README.md", "utf8");
  assert.match(readme, /\(\.\/docs\/guides\/air-gapped-multisig-signing\.md\)/);
});
