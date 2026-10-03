# No-patch dependency caller decisions

Scope: the dependency audit that blocked PR #8800 after Atlas integration.
Inspected application source: `958c6c7826e63593647946b26559d6b6cdbc7b08`.
Owner: WorldMonitor dependency maintainers. Each decision expires after
`2026-11-03T00:00:00Z` and remains an explicit audit warning. The original
one-week window ended 2026-10-10; npm still has no patched release.

Each decision is bound to the SHA256 of its exact reviewed lockfile. Any lockfile
change, including a new path or parent using the same advisory ID, fails the
decision until caller reachability is reviewed again. This also blocks unrelated
lockfile edits deliberately. The fingerprint does not prove source reachability;
the source-change conditions below still require a new review.

These are bounded caller decisions. The packages remain vulnerable upstream.
No audit gate, severity threshold, grace period or unrelated advisory is changed.

## Advisory and caller evidence

Both advisories were reviewed on October 2. GitHub lists no patched releases;
the npm registry still reports braces 3.0.3 and http-cache-semantics 4.2.0.

| Lockfile and advisory | Required attack path | Inspected caller and disposition |
| --- | --- | --- |
| Root and Pro: [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) | Attacker-controlled deeply nested patterns reach braces recursive AST walkers | Production lockfile inclusion comes through Clerk/Solana React Native peer dependencies. Root reaches Jest tooling; Pro reaches Metro file-map tooling. Both applications build browser bundles with Vite. Neither emitted bundle contains braces, micromatch, Metro file-map, Babel-Jest or the React Native community CLI. The inspected API, server, CLI and application sources do not call braces or micromatch. Root markdown lint also uses braces through a development dependency, with repository-controlled glob arguments. Retain these versions until `2026-11-03T00:00:00Z` or a patched release. |
| Blog: [GHSA-ch52-4w7c-c8xp](https://github.com/advisories/GHSA-ch52-4w7c-c8xp) | Client max-stale directives bypass protections in a shared cache containing another user's Set-Cookie response | `blog-site/astro.config.mjs` selects static output with no server adapter. Astro's `dist/assets/build/remote.js` uses CachePolicy for build-time remote images. Initial requests contain no client headers; revalidation adds only conditional ETag/Last-Modified headers and selects no-cache. These callers receive no incoming user request, max-stale directive or user cookie. The deployed blog serves generated static files. Retain 4.2.0 until `2026-11-03T00:00:00Z` or a patched release. |

The browser proof compiles the existing main and Pro Vite entrypoints and records
the modules in emitted chunks. Main emitted 2,324 modules; Pro emitted 746.
Both had zero modules from the five Node tooling packages listed above. This
is compiled-output evidence for those entrypoints, not a scan of Clerk's CDN
runtime, every dependency or an already deployed image.

The proof ran without source-map uploads. Its local module report and command
log are retained with the plugin acceptance evidence. Lockfile paths were also
checked with `npm ls --package-lock-only`, including production-only root reads.

## Removal and verification conditions

- Remove the relevant decision when the upstream advisory no longer matches,
  or when a compatible patched release can be installed and verified.
- Re-review immediately if a Node pattern service, Metro/Jest runtime, shared
  HTTP response cache, authenticated remote-image input or Astro server adapter
  is added. The current caller evidence would no longer justify the decision.
- Expiry, a stale advisory match or a changed/missing fingerprint fail the audit. The focused
  regression requires a visible warning while each decision is active and a
  failure after expiry or removal of its matching advisory.
- Other advisories retain their existing blocking behavior. Fresh audits must
  report warnings for these three lockfiles; they must not be described as clean
  or as upstream vulnerability repairs.

These decisions do not establish plugin acceptance. The deployed interactive
panels, matching source observations and native ChatGPT behavior still require
their separate acceptance checks.
