[33mcommit 2d967d7c7a86a374827f7d2e9658745afcab9b31[m[33m ([m[1;36mHEAD[m[33m -> [m[1;32mmain[m[33m, [m[1;31morigin/main[m[33m, [m[1;31morigin/HEAD[m[33m)[m
Author: WENeko <etienne.martin.pro@gmail.com>
Date:   Thu Aug 20 18:33:55 2026 +0200

    fix: mise a jour des chemins dans les scripts et du manifeste d'attribution

 docs/source-attribution.mdx        |  46 [32m+[m[31m--[m
 scripts/_511-rate-limit.mjs        |   2 [32m+[m[31m-[m
 ...forecast-market-settlements.mjs |   2 [32m+[m[31m-[m
 scripts/_gpsjam-parse.mjs          |   4 [32m+[m[31m-[m
 .../_iea-oil-stocks-helpers.mjs    |   2 [32m+[m[31m-[m
 scripts/_prediction-classify.mjs   |   2 [32m+[m[31m-[m
 scripts/_seed-envelope-source.mjs  |   2 [32m+[m[31m-[m
 scripts/_seed-utils.mjs            |   2 [32m+[m[31m-[m
 scripts/ais-relay.cjs              |  12 [32m+[m[31m-[m
 ...audit-china-decision-parity.mjs |  18 [32m+[m[31m-[m
 scripts/audit-mcp-api-coverage.mjs |  18 [32m+[m[31m-[m
 scripts/build-sitemap.mjs          |   4 [32m+[m[31m-[m
 scripts/capture-mcp-fixture.mjs    |   2 [32m+[m[31m-[m
 ...check-edge-function-bundles.mjs |   2 [32m+[m[31m-[m
 ...check-health-probe-cutovers.mts |   8 [32m+[m[31m-[m
 ...k-inventory-count-contracts.mjs |   2 [32m+[m[31m-[m
 .../check-postmerge-deploys.mjs    |   2 [32m+[m[31m-[m
 scripts/check-seed-freshness.mjs   |   8 [32m+[m[31m-[m
 scripts/docs-stats.mjs             |  70 [32m++[m[31m--[m
 ...enforce-rate-limit-policies.mjs |  20 [32m+[m[31m-[m
 .../enforce-sebuf-api-contract.mjs |   6 [32m+[m[31m-[m
 scripts/fetch-gpsjam.mjs           |   2 [32m+[m[31m-[m
 .../generate-country-bboxes.cjs    |   6 [32m+[m[31m-[m
 scripts/generate-iso3-maps.cjs     |   2 [32m+[m[31m-[m
 ...nerate-public-product-facts.mjs |   4 [32m+[m[31m-[m
 scripts/lib/_upstash-pipeline.mjs  |   4 [32m+[m[31m-[m
 .../lib/digest-delivered-log.mjs   |   2 [32m+[m[31m-[m
 scripts/mcp-budget-check.mjs       |   2 [32m+[m[31m-[m
 .../measure-jmespath-savings.mjs   |   2 [32m+[m[31m-[m
 ...sure-tools-list-compression.mjs |   6 [32m+[m[31m-[m
 .../openapi-inject-jmespath.mjs    |   2 [32m+[m[31m-[m
 scripts/railway-services.json      |   4 [32m+[m[31m-[m
 .../freshness.mjs                  |   4 [32m+[m[31m-[m
 scripts/seed-aviation.mjs          |   8 [32m+[m[31m-[m
 scripts/seed-bis-data.mjs          |   2 [32m+[m[31m-[m
 scripts/seed-bis-extended.mjs      |   6 [32m+[m[31m-[m
 .../seed-bundle-energy-sources.mjs |   2 [32m+[m[31m-[m
 scripts/seed-climate-anomalies.mjs |   2 [32m+[m[31m-[m
 .../seed-climate-zone-normals.mjs  |   2 [32m+[m[31m-[m
 scripts/seed-commodity-quotes.mjs  |   2 [32m+[m[31m-[m
 ...seed-comtrade-bilateral-hs4.mjs |   2 [32m+[m[31m-[m
 scripts/seed-conflict-intel.mjs    |   6 [32m+[m[31m-[m
 .../seed-cross-source-signals.mjs  |   2 [32m+[m[31m-[m
 .../seed-digest-notifications.mjs  |   2 [32m+[m[31m-[m
 .../seed-education-attainment.mjs  |   2 [32m+[m[31m-[m
 scripts/seed-forecasts.mjs         |   8 [32m+[m[31m-[m
 .../seed-freshness-baseline.json   |   2 [32m+[m[31m-[m
 scripts/seed-fsi-eu.mjs            |   4 [32m+[m[31m-[m
 ...eed-gdelt-bulk-materializer.mjs |   2 [32m+[m[31m-[m
 scripts/seed-iran-events.mjs       |   2 [32m+[m[31m-[m
 scripts/seed-national-debt.mjs     |   2 [32m+[m[31m-[m
 .../seed-recovery-fiscal-space.mjs |   2 [32m+[m[31m-[m
 .../seed-regional-snapshots.mjs    |   2 [32m+[m[31m-[m
 .../seed-supply-chain-trade.mjs    |   4 [32m+[m[31m-[m
 scripts/seed-ucdp-events.mjs       |   2 [32m+[m[31m-[m
 .../shared/jodi-content-age.mjs    |   2 [32m+[m[31m-[m
 scripts/shared/ucdp-candidate.cjs  |   2 [32m+[m[31m-[m
 scripts/smoke-jmespath-edge.mjs    |  14 [32m+[m[31m-[m
 .../sync-bootstrap-tier-keys.mjs   |   6 [32m+[m[31m-[m
 scripts/validate-rss-feeds.mjs     |  12 [32m+[m[31m-[m
 ...verify-seed-envelope-parity.mjs |  10 [32m+[m[31m-[m
 .../api-route-exceptions.json      |   2 [32m+[m[31m-[m
 ...ource-attribution-manifest.json | 184 [32m++++++[m[31m-----[m
 tests/mcp-resources.test.mjs       |   2 [32m+[m[31m-[m
 ...nrcan-earthquakes-atom.test.mjs |   2 [32m+[m[31m-[m
 65 files changed, 292 insertions(+), 286 deletions(-)
