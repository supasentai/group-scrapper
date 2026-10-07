/**
 * Browser-console smoke preamble for FB Group Lead Pilot.
 *
 * Paste this file first into an open Facebook Group tab, then paste the local
 * fb-group-lead-pilot.js file. It configures a short, bounded run without
 * loading any external script (Facebook CSP blocks that):
 * - 3-day cutoff
 * - no checkpoint reuse
 * - at most 4 scroll rounds or 90 seconds
 *
 * The bounded run intentionally produces a manifest with status=stopped when
 * the safety limit is reached. Use it to validate DOM extraction and output;
 * do not treat it as a complete marketing dataset.
 */
(() => {
  if (!/facebook\.com\/groups\//i.test(location.href)) {
    throw new Error("Open a Facebook Group tab before running the smoke test.");
  }
  if (globalThis.__FB_GROUP_LEAD_PILOT_RUN__) {
    throw new Error("A collector run is already active in this tab.");
  }

  globalThis.__FB_GROUP_LEAD_PILOT_OPTIONS__ = {
    days: 3,
    useCheckpoint: false,
    scrollIntervalMs: 2200,
    maxIdleRounds: 2,
    maxOldPostRounds: 1,
    maxRounds: 4,
    maxRuntimeMs: 90_000,
  };

  console.info("Smoke options set. Now paste the local fb-group-lead-pilot.js file.",
    globalThis.__FB_GROUP_LEAD_PILOT_OPTIONS__);
})();
