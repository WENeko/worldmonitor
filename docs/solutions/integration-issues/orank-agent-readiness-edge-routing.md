---
title: Agent discovery and error responses across Cloudflare and Vercel
date: 2026-09-05
category: integration-issues
module: Agent discovery
problem_type: integration_issue
tags: [orank, cloudflare, markdown, api-errors]
---

# Agent discovery and error responses across Cloudflare and Vercel

The September 5, 2026 orank result was 96/100. Live checks confirmed that `/?mode=agent` already returned the expected JSON. The REST schema contract checks passed. World Monitor has no GraphQL API. A firewall 403 on `/api/graphql` does not establish that an authenticated GraphQL service exists.

The remaining request paths cross two deployment systems.

- Vercel middleware routes the declared AI User-Agents to `public/home.md`. It preserves JSON agent mode, browser HTML, variant hosts, and dashboard links. The response disables caching and declares `Vary: User-Agent`.
- Cloudflare can serve cached homepage HTML before Vercel middleware runs. Cloudflare does not use `Vary: User-Agent` as a cache key. An additional cache bypass must run after the existing homepage cache rule.
- The Cloudflare rules `Block API Bots` and `Block Scriptlike UAs` return HTML before API handlers run. Both need custom JSON block responses. The change preserves their expressions, actions, order, and existing authentication exceptions.

The shared User-Agent list and denial body live in `shared/agent-request-policy.json`. Public Markdown files carry title, description, and canonical metadata. Generated Markdown documents carry title and canonical metadata. Metadata dates are omitted because a request date does not establish when source content changed.

All 90 original Markdown links in `llms.txt` were checked with redirect-following GETs and body inspection. El País resolved in that run. Two press sites and npm blocked automated requests, while the documentation MCP transport returned a protocol-level 405 to GET. The index now points to the first-party identity document, CLI guide, and documentation MCP server card. Press citations and transport addresses remain available in those documents.

## Prepare the Cloudflare change

Set exactly one of `CLOUDFLARE_API_TOKEN` or `CLOUDFLARE_ALL_ACCESS_TOKEN`. Use a token scoped to the WorldMonitor zone with WAF and cache-rule edit permissions. The script can load these names through the standard `loadEnvFile()` path. No credential belongs in the plan or Git.

```sh
node scripts/cloudflare-agent-readiness.mjs --plan
node scripts/cloudflare-agent-readiness.mjs --check
```

`--plan` reads the live zone and prints the proposed per-rule changes. `--check` exits nonzero while changes remain. Both are read-only. Review the plan before applying it.

## Deploy and verify

After approval, apply the Cloudflare change before deploying the origin change. This order prevents cached HTML from hiding the new Markdown response. Applying the cache bypass early only reduces caching for the declared crawler homepage requests.

```sh
node scripts/cloudflare-agent-readiness.mjs --apply
node scripts/cloudflare-agent-readiness.mjs --check
```

`--apply` changes production Cloudflare configuration. It patches individual rules, stops if the rules change after planning, and verifies the result. It does not replace a ruleset. After the normal origin deployment, run the live response checks.

```sh
node scripts/verify-agent-readiness.mjs https://www.worldmonitor.app
curl -sS -X POST https://ora.ai/api/scan \
  -H 'Content-Type: application/json' \
  -d '{"url":"worldmonitor.app"}'
curl -sS https://ora.ai/api/score/worldmonitor.app
```

The response checker performs public GETs only. A local test pass does not prove Cloudflare activation, Vercel rewrite behavior, or a new orank score. The scan endpoint can return a cached result; compare the response timestamp and cache fields before claiming an improvement.

Cloudflare documents [custom JSON block responses](https://developers.cloudflare.com/waf/custom-rules/create-api/) and [per-rule updates](https://developers.cloudflare.com/ruleset-engine/rulesets-api/update-rule/). The update API requires the full retained rule definition even when only the response body changes.
