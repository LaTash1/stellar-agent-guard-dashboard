# Air-Gapped Multisig Signing: A Complete Round Trip

This guide is the repeatable procedure for taking an admin transaction that needs several
co-signers from an unsigned envelope, through offline signing on separate machines, and back into
the network — without ever handing a secret key to the dashboard.

It covers the two panels involved:

- **Multisig approvals** (`components/MultisigTracker.tsx`) — paste a pending envelope to see the
  collected signature weight, the remaining weight at each threshold, who has signed and who has
  not, and the transaction hash to coordinate around.
- **Submit Signed XDR** (`components/SubmitSignedXDRPanel.tsx`) — broadcast the fully signed
  envelope once the tracker reports it is ready.

> **The dashboard never needs — and never asks for — a secret key.** Every signature is produced
> outside it, in a wallet or on an offline machine, and the dashboard only reads public chain
> state and broadcasts the envelope the operator pastes back. There is no API route, no server
> signing and no secret-key persistence in this repository.

---

## 1. The safety model

| Property                                 | What it means for this procedure                                                                                                                                      |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client-only                              | Parsing, weight arithmetic and submission happen in the browser (or your offline tool). Nothing is proxied through a project server.                                  |
| Non-custodial                            | Signing keys live in Freighter, a hardware wallet, or an air-gapped signer. The dashboard holds none.                                                                 |
| Chain state is authoritative             | Signer weights and thresholds are read fresh from Horizon at check time. Cached or locally stored data is never treated as a live read.                               |
| XDR is not a secret, but it is sensitive | An unsigned envelope reveals intent (destination, amount, contract call). Treat the file as confidential operational data even though it contains no keys.            |
| Append-only signing                      | Co-signers add signatures to the _same_ envelope. Rebuilding the transaction between signers changes its hash and sequence number, stranding every earlier signature. |

---

## 2. Before you start

- [ ] You know which network the transaction belongs to. The dashboard shows its pinned network in
      the wallet bar; public testnet uses the passphrase `Test SDF Network ; September 2015`.
- [ ] You know the **source account** of the envelope. That account — not the guarded contract —
      is the one whose signer weights and thresholds decide the approval.
- [ ] Every co-signer has the current signer list and thresholds for that source account, and has
      been told the transaction hash out of band.
- [ ] You have at least two independent channels for the hand-off (for example a shared drive and a
      chat message), so a substituted file is detectable.
- [ ] The transaction is still inside its time bounds. An envelope that expires mid-collection has
      to be rebuilt from the start.

---

## 3. The round trip at a glance

| Step | Where                     | Action                                       | Output                        |
| ---- | ------------------------- | -------------------------------------------- | ----------------------------- |
| 1    | Online, operator          | Build the transaction and verify the network | Unsigned envelope XDR + hash  |
| 2    | Online, operator          | Export the XDR to a file and record its hash | `unsigned-envelope.xdr`       |
| 3    | Offline hand-off          | Move the file to each signer                 | Copied file, hash re-verified |
| 4    | Offline / hardware signer | Review and append a signature                | Partially signed envelope     |
| 5    | Online, operator          | Check collected vs remaining weight          | Approval verdict              |
| 6    | Online, operator          | Paste into **Submit Signed XDR** and review  | Confirmation, then broadcast  |
| 7    | Online, operator          | Confirm inclusion on chain                   | Ledger and result hash        |

---

## 4. Step 1 — Verify the network before anything is signed

A signature produced for one network cannot authorize on another, and the failure only appears at
submission time. Check this first.

1. Confirm the dashboard's network indicator matches the network your signers will use.
2. Confirm the envelope was built with the same network passphrase. The passphrase is part of what
   is signed; a testnet envelope signed as if it were pubnet is simply invalid.
3. Confirm the source account exists on that network and is funded. An unfunded source is rejected
   with `tx_no_source_account` and cannot be rescued by more signatures.

If the dashboard warns that the wallet's network and the build's configured network disagree, stop.
Reconnect the wallet to the correct network before signing anything.

---

## 5. Step 2 — Build and export the unsigned envelope

Build the transaction in the tool that owns the operation (an SDK script, Stellar Laboratory, or an
offline workstation). For a guard admin operation the envelope typically contains one invocation of
the guarded contract.

Before exporting, record the facts every signer must be able to verify:

```text
Network passphrase: Test SDF Network ; September 2015
Source account:     G…            (the multisig account)
Sequence number:    <n>           (current sequence + 1)
Time bounds:        <minTime>–<maxTime>
Operations:         <n>           (contract ID, method, arguments)
Hash:               <hex>         (from the envelope, not recalculated by hand)
```

Then create the file:

```bash
# The XDR is base64 text; keep it exactly as produced.
printf '%s' "$UNSIGNED_XDR" > unsigned-envelope.xdr
sha256sum unsigned-envelope.xdr > unsigned-envelope.xdr.sha256
```

Rules for the file:

- Keep it plain base64. Do not wrap, re-indent or "fix" line breaks — a single changed character
  makes the envelope undecodable.
- Never place an envelope in a public URL, issue tracker, screenshot or chat preview. Share the
  file through an access-controlled channel.
- Keep the checksum file with it; step 3 verifies it before any signer touches the envelope.

---

## 6. Step 3 — Hand off safely

For each signer:

1. Send `unsigned-envelope.xdr`, `unsigned-envelope.xdr.sha256`, and the hash **through separate
   channels** when possible.
2. The signer verifies the checksum before opening the file:

   ```bash
   sha256sum -c unsigned-envelope.xdr.sha256
   ```

3. The signer opens the envelope in their own tooling — wallet, Stellar Laboratory, or an offline
   signer — and compares the hash, source account, sequence, time bounds and operation list
   against the values the coordinator announced. If any value differs, stop and discard the file.

The dashboard never asks the signer to paste a secret key into a web page, and the coordinator never
needs one either.

---

## 7. Step 4 — Collect partial signatures

Each signer signs the **same** envelope and returns it with one more signature. Signers append;
they do not rebuild.

- Signing is additive: adding a signature does not change the transaction hash, so the hash you
  announced in step 2 stays valid for the whole round trip. Verify it after every hand-off.
- A partially signed envelope is a normal state, not an error. It simply has not reached the
  threshold yet.
- Store each returned file under a new name (`envelope-admin1.xdr`,
  `envelope-admin2.xdr`, …). Never overwrite the unsigned original; it is the fallback if one
  signer's tool produces an incompatible signature.

What "enough" means depends on **weight**, not signature count. With weights 10/10/10 and a medium
threshold of 20, two signatures are enough; with weights 20/10 and a threshold of 20, one
signature is. That is exactly what the tracker computes.

If a signer's key was removed from the account after the envelope was built, their signature is
still on the envelope but contributes no weight — the network validates signatures against the
current signer set. The tracker flags such signatures as unmatched rather than counting them.

---

## 8. Step 5 — Check collected and remaining weight

Open **Multisig approvals**:

1. Paste the latest envelope XDR into **Pending transaction envelope (base64 XDR)**.
2. Select **Check approvals**. The panel reads the source account's signers and thresholds from
   Horizon and analyses the envelope locally.
3. Read the result:

   - **Collected weight N of M required** — the progress bar fills against the governing threshold.
   - **Remaining signer weight** — one line per threshold:

     | Display                                            | Meaning                                                                                                                                                                                             |
     | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
     | `met`                                              | Collected weight already satisfies that threshold.                                                                                                                                                  |
     | `<n> more weight required`                         | Exactly `n` more weight is needed at that threshold.                                                                                                                                                |
     | `unknown — signer data could not be fully matched` | The account holds signers whose signatures the envelope cannot reveal (hash, pre-auth, signed-payload or ambiguous-hint signers). Collected weight is a lower bound, so no exact number is claimed. |

   - **Ready to submit** or **Pending co-signatures** — the verdict for the governing (medium)
     threshold.
   - **Signature(s) match no current account signer** — stale signatures from removed keys. They do
     not count.
   - **Signer(s) signed the envelope more than once** — duplicates are counted once, exactly as the
     network counts them.

4. Use **Copy hash** and **Copy envelope XDR** to send the current state to the next co-signer.

A failed Horizon read is shown as an error, never as `0 of 0`. If the read fails, resolve the
connectivity or account problem and check again; do not infer the approval state from a previous
run, because local data is not a substitute for the live read.

---

## 9. Step 6 — Import, review and submit

When the tracker reports **Ready to submit**:

1. Open **Submit Signed XDR**.
2. Paste the fully signed envelope (the one whose hash matches the hash from step 2).
3. Before pressing **Submit to Network**, complete the final review:

   - [ ] The hash shown by the tracker matches the hash in the envelope you are about to submit.
   - [ ] The network indicator still matches the network the envelope was built for.
   - [ ] The source account, sequence number and time bounds are the values that were reviewed by
         the signers.
   - [ ] The operation list contains only the intended operation — no extra contract invocation,
         bump, or fee-bump wrapper was introduced during the hand-off.
   - [ ] The tracker's verdict is **Ready to submit**, not "pending".

4. Submit. A successful submission returns a transaction hash; the network has accepted the
   envelope for inclusion, not necessarily executed it yet.

---

## 10. Step 7 — Confirm inclusion

Poll the submitted hash with `getTransaction` (the dashboard's normal submission path does this for
its own transactions; for a manually submitted envelope, use the same RPC endpoint) until the status
is `SUCCESS` or `FAILED`.

- `SUCCESS` — the transaction executed. Record the ledger number and result.
- `FAILED` — the transaction was included but the operation failed. The result XDR carries the
  reason; fix the cause and build a **new** envelope from a fresh sequence number.
- `NOT_FOUND` immediately after submission is usually "in flight". Re-check for a few ledgers
  before treating it as lost.

---

## 11. Recovery playbook

| Symptom                                    | Likely cause                                                                                                                                    | Recovery                                                                                                                                                                           |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tx_bad_seq`                               | Another transaction from the source account landed after the envelope was built, or a previous submission succeeded.                            | Read the current sequence, rebuild the transaction, and restart collection from step 2. Existing signatures cannot be reused.                                                      |
| `tx_too_late`                              | The envelope's maximum time bound passed while signatures were being collected.                                                                 | Rebuild with a new time window and restart collection. Do not submit an expired envelope repeatedly.                                                                               |
| `tx_too_early`                             | The envelope's minimum time bound is in the future.                                                                                             | Wait until the window opens, or rebuild with a valid window.                                                                                                                       |
| `tx_bad_auth` / insufficient weight        | Not enough valid signer weight, a signature for the wrong network, or a signer that was removed.                                                | Re-check the tracker: collected weight, unmatched signatures, and the source account's current signer set. Collect the missing weight or rebuild if the signer set changed.        |
| `tx_bad_auth_extra`                        | The envelope carries signatures the account does not need or does not recognize.                                                                | Remove the extras in your offline tool (or use the correct envelope), verify the hash, and resubmit.                                                                               |
| Incompatible envelope / decode error       | Wrong network passphrase, a fee-bump envelope where a regular one is expected, truncated or re-wrapped base64, or a different transaction type. | Re-export the original file, verify its checksum and hash, and confirm the passphrase. If the type is wrong, rebuild the intended transaction.                                     |
| Transaction rejected with a contract error | The guard policy or auth check rejected the invocation.                                                                                         | Treat it as an on-chain policy decision, not a signing problem. Review the diagnostic events and the policy, then rebuild.                                                         |
| Tracker says "unknown" remaining weight    | The account has hash, pre-auth, signed-payload or ambiguous-hint signers.                                                                       | Collect signatures from those co-signers as usual, then re-read the account after they sign; the tracker will report a definite verdict only when it can attribute the signatures. |
| Horizon read fails                         | RPC/Horizon outage or wrong account ID.                                                                                                         | Fix connectivity/account ID and re-run the check. Never infer approval from cached state.                                                                                          |

---

## 12. What the dashboard will never ask for

- A secret key, mnemonic or seed phrase.
- A signed envelope to be uploaded to any server other than the public network RPC it is
  configured for.
- Permission to store signing material. The address book stores labels only; the transaction
  history stores hashes and outcomes, not keys.

If a workflow step seems to require any of those, stop: it is outside the documented
client-only, non-custodial architecture of this dashboard.

---

## Related documentation

- [Overview Screen](../screens/overview.md)
- [No Mock State](../concepts/no-mock-state.md) — why every read shown here comes from chain state.
- [Client-Side Freighter Architecture](../concepts/client-side-freighter-architecture.md)
- [Routine Policy Updates & Audit](../runbooks/policy-updates.md)
