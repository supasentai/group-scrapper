# Project instructions

Read `ORCHESTRATION.md` before collecting data or processing batch outputs.

## Active browser profiles

As requested by the user on 2026-11-06, use only ports 9222 and 9223 with
`.cdp-profiles/edge-9222` and `.cdp-profiles/edge-9223`. All other browser
profiles have been retired after bans. Open and collect with these two profiles
unless the user explicitly changes this instruction.

## New collection batches

For new collection batches, use `--capture-mode posts` unless the user requests
comment or reply rows. This mode reads posts directly from the group feed and
uses each post card to verify its permalink. Pass the capture mode in the batch
handoff.

## Collector automatic handoff

The user explicitly authorized automatic Collector-to-Aggregate handoff on
2026-11-03: "setup cho collector khi gom data về rồi thì tự động bàn giao cho
Aggregate downstream formatting".

After completing and validating an assigned batch, follow the **Automatic
Collector-to-Aggregate handoff** section in `ORCHESTRATION.md`. This is standing
authorization to send that batch to the existing Aggregate chat without asking
for another handoff command. It does not authorize starting a new collection,
content filtering, formatting, or commit/push.
