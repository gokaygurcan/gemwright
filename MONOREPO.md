# Monorepo architecture and delivery plan

Work on `monorepo`. Steps 0–6 are complete; Step 7 is in progress and publication is on hold during cleanup. Step 6 live acceptance covers ServUO server/client/AI isolation only. Workspace versions remain `0.7.0`; the pending Changeset targets `0.8.0`. Nothing has been committed, pushed or published during this migration.

Finish each step before starting the next. This plan does not itself authorize publication or deployment. Preserve unrelated working-tree changes.

## Decisions

1. Prioritize Railway, then local, then VPS. Preserve existing local/VPS behavior without building another deployment platform.
2. Packages need clear ownership and useful standalone behavior. Publish only packages with a useful public application or API; private packages are valid long-term.
3. Initially use one shared version for every package, including private packages. Changesets aligns versions; only public packages publish. Fixes use patch, features use minor, and breaking changes use minor before 1.0 or major afterward. The package name does not determine the bump.
4. Develop and build with Bun. The installed CLI and wrapper support Node 24+ without Bun. AI/client/analyze/network may require Bun 1.4.3+. Common stays runtime-neutral where practical; deployment code used by CLI stays Node-compatible.
5. `@gemwright/cli` owns commands and presentation. `gemwright` delegates directly to its exact matching version in the same process. Bins are `gemwright-cli` and `gemwright`; preserve `npx gemwright`, arguments, signals and exit codes.
6. Use one root tsconfig. Root `bun run build` uses native Bun workspace ordering; no Turbo, custom build orchestrator, extra root configs or verification command family. Package scripts compile directly; source helpers handle only CLI asset copying and client asset compression.
7. Public applications bundle required private workspace code. No unpublished runtime dependency or unresolved `workspace:` range may require an npm consumer to access this repository. Internal public runtime dependencies use exact matching versions.
8. Use `schemaVersion` in `gemwright.json`, one JSON Schema and internal component compatibility rules in common. Missing schemaVersion means 1. Validate before mutation. Unknown schemas, unsupported versions and malformed configuration fail with an update command. Add migration tooling only when a real migration needs it.
9. AI, client and server own separate services and processes. Updating one never changes or restarts another. Server runs alone, with either service or with both; client and AI accept explicit compatible counterparts without a CLI-created server. AI currently supports ServUO only.
10. Select exact published component versions through `gemwright update`; selection changes configuration, not running deployments. Deployment is explicit. Failed retrieval never falls back to another version. Keep CLI-carried artifacts when no version is selected until publication availability supports removing that path.
11. Contained npm packages carry their required build/deployment assets. Railway uses its existing build flow; no separate image registry, release manifest or artifact catalog. Preserve persistent data and resource identities on updates.
12. Require an installed/authenticated Railway CLI. Version `5.71.0` is tested/recommended; other versions warn and attempt the command. Actual command/parse failures remain failures. Never silently install or upgrade the user's CLI.
13. Release retries publish only missing versions in dependency order from original workflow artifacts. Announce only after all intended public publications succeed. Metadata retries repair missing tags/releases without republishing. No custom release database or automatic deployment.
14. Build package boundaries before observability. Standardized logs come next, then complete optional OpenTelemetry. Grafana and other exporters are explicit opt-ins. Exporter failure must not disrupt the application.
15. Keep package READMEs to the shared root header, usage/help or exported configuration, and MIT. Maintain third-party references in the single root third-party file.

## Package ownership

| Package | Owns | Runtime / publication decision |
| --- | --- | --- |
| `gemwright` | Thin CLI entry point | Node; public |
| `@gemwright/cli` | Commands, prompts, presentation and adapter composition | Node; public for 0.8.0 |
| `@gemwright/server` | Emulator integration, templates, patches and staging | Node staging; private |
| `@gemwright/client` | Browser payload, HTTP/WebSocket host and owned deployment files | Bun; public for 0.8.0 |
| `@gemwright/ai` | Resident runtime, persistence and domain event journal | Bun; public for 0.8.0 |
| `@gemwright/network` | Protocol, sessions, transport, observations and diagnostics hooks | Bun; private |
| `@gemwright/common` | Shared game data, codecs, asset readers, configuration/schema/compatibility | Private source package |
| `@gemwright/deployment` | Deploy/pull/restore, provider adapters and transfer workflows | Node-compatible; private |
| `@gemwright/analyze` | Inspection and reporting | Bun/browser; private |
| Observability (planned) | Logging contracts, context, redaction, instrumentation and exporters | Publication/layout undecided |

Common exports `game`, `codecs`, `assets` and `config` subpaths; it does not own deployment workflows. The name `deployment` reflects deploy/pull/restore ownership rather than the broader rejected name `operations`.

Dependency direction: network → common; AI → common/network; client → common; deployment → common/client file contracts; server → common/deployment utilities; CLI composes these owners; analyze → common/deployment. Lower-level packages import neither CLI nor analyze. Deployment receives server adapters rather than importing server. Keep this graph acyclic.

Observability must not depend on AI/network. AI owns domain meanings and journal durability/retention; provider logs and OpenTelemetry do not replace its replay journal. Further package splits require a demonstrated consumer rather than a predetermined folder layout.

## Ordered work

### Step 0 — Working branch: complete

Use `monorepo` for reviewable changes. Preserve public CLI behavior and finish each numbered step before advancing. Publication/commit grouping is separate from implementation order.

### Step 1 — Inventory and ownership: complete

Inventoried imports, package/build inputs, runtimes, emulator assets, provider mutations and public candidates against baseline `6e1ee27dbb941bc1e471ebc10f81edfcf36e2d6e`. Settled common/deployment ownership and the wrapper approach before extraction.

The inventory's follow-through is implemented in Steps 2–6: remove analysis-to-CLI imports; separate emulator files from CLI presentation; remove whole-workspace image staging; move AI trust changes to explicit server operations; support explicit counterparts; preserve service/volume identity. Publication checks remain Step 7 work.

### Step 2 — Shared boundaries and runtime support: complete

Organized common exports and extracted private deployment workflows. AI/network retain Bun SQLite/TCP/timers; client/analyze retain Bun hosting. CLI builds for Node. Private shared code is bundled by its application owner; no dual-runtime adapter or declaration pipeline was introduced.

Removed `packages/ai/docs`, extra root tsconfigs, temporary compiler-output machinery and separate verification commands. Current builds use native workspace ordering. Validation included standalone analysis, AI persistence workers, Node CLI startup and both contained images.

### Step 3 — CLI/server extraction and wrapper: complete

Scoped CLI owns commands and exports `main`/`run`. The wrapper calls the same runner. Server owns emulator integration and exposes `dist/staging.js`; CLI owns questionnaire-based initialization and composes server adapters. Packed installs under Node without Bun passed help/version, invalid arguments, cancellation/SIGTERM, interactive initialization and all five emulator staging paths.

### Step 4 — Shared versioning and retryable releases: complete

Changesets uses one fixed group for `gemwright` and `@gemwright/*`, with private versioning enabled and private publication/tags disabled. Root checks run lint, typecheck, native workspace builds and full tests. Upstream emulators are not rebuilt by ordinary package builds.

Release flow: checks → version/publish selection → version PR or build/pack → publish → announcement. `.changeset/release.ts` only refreshes the missing-version plan for original artifacts and reconciles missing GitHub releases. It does not select affected files or orchestrate builds.

Rehearsals verified a private common change aligns every fixture version and keeps the wrapper dependency exact. A five-package release with three successes and two failures retried only the missing two. Announcement waited for completion; later metadata retries made no further npm publication attempts. Bad artifact integrity and failed registry reads stopped publication.

Recovery: rerun failed jobs at the same commit while the original artifacts remain available. Changesets artifacts are retained for 30 days. Do not change versions/source or rebuild implicitly to recover a partial publication. Decide recovery explicitly if artifacts expire. See `.changeset/README.md` for operating instructions.

### Step 5 — Configuration compatibility: complete

Common owns the JSON Schema and component compatibility checks. Schema 1 accepts stable component versions `>=0.7.0 <1.0.0`; this is a deployment configuration contract, not a promise that every game protocol is interchangeable. Explicit selections must be exact stable versions.

`gemwright update` reports newer compatible packages and the selection/deploy commands. `gemwright update --ai --package-version <exact>` validates publication and compatibility, then updates only the selected setting. It does not deploy. Configuration validation and unsupported-schema checks precede provider mutation.

### Step 6 — Standalone delivery and Railway isolation: complete for ServUO

Contained AI/client images require neither the root lockfile nor sibling installations. AI includes workers, catalogs, locations, templates, world data and tuning. Client includes its compiled host/browser payload. Server staging includes templates and patches. Game files, saves, secrets and resident databases remain external inputs.

Exact selected npm packages are packed with lifecycle scripts disabled; retrieval checks identity, schema, required files and unsafe archive entries before staging. Temporary directories are removed on success/failure. A failed explicit selection does not use carried artifacts.

Counterpart configuration:

- `railway: { project, environment, server }` adopts an existing Railway server by ID/name.
- `railway: { project, environment }` plus `connection: { host, port }` targets an external compatible server.
- External AI additionally requires `connection.aiReady: true`, the operator's confirmation of the ServUO patch, account creation and trusted source. This is not an automatic capability probe.

Isolation rules:

- AI checks patch/trust/account/assets/credentials before provisioning. AI-only operations never write server variables or restart server/client. Explicit `gemwright deploy --server --ai` installs the patch and updates trust while preserving other trusted hosts. Server-only updates retain the recorded AI patch.
- Each service records its own project/environment/service/volume. Reruns discover existing resources before creation. Missing recorded resources, changed mounts and target mismatches fail rather than replacing persistent resources. Reuse existing client domains.
- AI-only pull/restore does not require a server volume. Restore is separately selected and confirmed and restarts only selected services.
- Poll for the new deployment ID. Server readiness checks imported assets and game TCP; client checks HTTP; AI checks bootstrap/map ingestion. Bootstrap does not prove game login. Failures identify scoped Railway logs commands; recovery remains manual.
- Client imports record the manifest digest before serial upload. Explicit retry with the same digest reuses matching path/type/size entries, transfers missing files, verifies everything and commits readiness last. Changed inputs and provider-read failures stop. This is not a general automatic recovery engine or a checksum proof against same-size external modification.
- Local/VPS remain server-led. Independent pinned package delivery currently applies to Railway; VPS rejects unsupported selections rather than substituting another artifact. Broader VPS isolation is deferred.

Validation evidence:

- Packed AI/client/server ran outside the workspace: AI validated, bootstrapped, persisted and shut down; client served readiness/browser assets; server imported under Node with five adapters. An unchanged CLI retrieved/staged exact AI `0.8.0` from a local fixture registry.
- Contained service images built and passed AI validation/client readiness with Bun 1.4.3. Node-only CLI installs passed without Bun.
- Live acceptance on 2026-10-30 used a disposable Railway project with ServUO/client/AI and three volumes. No Sphere/MySQL resources were created. The project was deleted and confirmed inactive; production identities remained unchanged.
- Initial server provisioning, imports, public TCP and prerequisite failure passed. Explicit server+AI setup enabled a real resident login. Resident identity/serial and persisted state survived component updates and server reconnection.
- Loopback registry candidates confirmed exact AI/client/server updates through the older CLI. Each update preserved the other deployment IDs, all volume IDs and managed variables. AI/client also updated from independent directories with explicit counterparts.
- Public client returned 503 before importing 254 files, then became ready. WebSocket login worked over private networking before/after update. Upload retry retained 118 completed files (about 2 GiB). These checks caught and fixed the Railway project-name limit and concurrent-upload stall.
- Final Step 6 validation passed 481 tests plus build/lint/typecheck and Node smoke checks. After removing the obsolete affected-check test, cleanup validation passed 480 tests, standalone package checks and analyzer static assets. Test counts are evidence, not a fixed requirement.

### Step 7 — Publication readiness: in progress, on hold

Prerequisite: Steps 0–6. The user selected `0.8.0` and four public packages: `gemwright`, `@gemwright/cli`, `@gemwright/ai`, `@gemwright/client`. Keep the other five private. Do not apply the pending version bump or publish during cleanup.

Remaining work, in order:

1. Finish reviewing the simplified migration and inspect final tarballs/clean installs. Confirm dependency closure, third-party provenance/references and exclusion of user data/secrets. The browser input was matched to UO Nexus minimal v1.0.56; details belong in the root third-party file.
2. Reconcile npm ownership and publication authentication for all four packages. `gemwright` already has a trusted publisher for this repository's `release.yml`/`npm` environment. The scoped packages do not yet exist; their first real publication requires authenticated bootstrap before trusted publishing can be configured. Do not publish placeholders or put tokens in files/chat.
3. Decide reviewable commit grouping and clear the publication hold before applying versions or publishing. Passing a check is not permission to publish. Lint/typecheck must pass before commit/deployment; tests before push.
4. Publish the approved artifacts through the agreed release flow, finish scoped trusted-publisher setup and verify package availability/retry behavior. Publication never updates running services.
5. Revisit removing carried artifacts only once the published replacement is available and independent delivery remains usable.

Complete when the approved public packages are available, private packages remain unpublished, authentication/retry behavior is verified and the release outcome is recorded. Do not mark this complete on the strength of local rehearsals alone.

### Step 8 — Logging and `gemwright logs`: pending

Prerequisite: package boundaries and completion of the current step, unless the user changes the order.

1. Inventory actual outputs and establish observability ownership for structured logs, context, service/version/deployment identity, redaction and error serialization. Preserve AI journal/replay behavior.
2. Implement `gemwright logs`: all services by default with labels; combinable `--server`, `--client`, `--ai`; `--watch` streams to the current terminal. Use installed Railway CLI log access without storing another centralized copy.
3. Separate operational logs from CLI report stdout. Handle missing services and cancellation. Local/VPS adapters use known managed/configured sources; explicitly defer adapters requiring substantial work.

Complete when Railway logs work without Grafana/OTLP, the agreed flags work and journals remain readable. Record any local/VPS gaps honestly.

### Step 9 — Optional OpenTelemetry: pending

Prerequisite: Step 8 and working standalone/deployment foundations.

1. Add consistent metrics, useful histograms/spans and context propagation with optional OTLP export. Grafana is an explicitly configured backend, not a requirement.
2. Bound export queues, retries and shutdown flushing. Export failure must not block application work or recursively log itself. Keep high-cardinality IDs out of metric labels and preserve credential redaction.
3. Verify exporter-disabled, backend-failure and successful collection paths. Choose collector/backend configuration from actual Railway/runtime capabilities. Assess dashboards/alerts after instrumentation works.

Complete when instrumentation and optional export work across supported processes with no mandatory external account.

## Decision history and deferred work

These dispositions replace the old repeated proposal text. Revisit them only for a demonstrated need; do not treat them as current requirements.

| Proposal | Disposition / revisit condition |
| --- | --- |
| Separate server/AI/client protocol, deployment and telemetry contract versions | Use schemaVersion and internal component ranges; revisit when a real incompatibility cannot fit that model. |
| Mandatory configuration migration command | Deferred until a concrete migration needs conversion. |
| Release manifests, completed-release pointers, artifact catalogs | Replaced by contained versioned npm packages; revisit a demonstrated distribution limitation. |
| Separate image registry/digest deployment platform | Deferred while existing Railway builds suffice. |
| Durable release state machine, release IDs, candidate promotion transaction | Replaced by ordinary workflow retries that skip published versions. |
| Custom archive/integrity reconciliation platform | Standard pack hashes, registry protections and workflow artifacts suffice initially. |
| Automatic rollback, database restore or migration rollback engine | Deferred; fail clearly and recover manually. Data-safety requirements need an explicit design if introduced. |
| Durable deployment checkpoint engine for every mutation | Reuse provider resource discovery and focused import state; revisit actual recovery failures. |
| Selected-service updates may change/restart another service | Rejected; requires an explicit change to the isolation decision. |
| Reject untested Railway versions or silently install/upgrade the CLI | Rejected; warn and run, fail on real command/output errors. |
| Universal Node migration for service internals | Superseded by Node CLI plus Bun services; do not reintroduce SQLite/TCP/HTTP adapters or extra build configs. |
| Publish every package | Rejected; require useful standalone value. Server remains private pending public API cleanup. |
| Shared versions only for public packages | Rejected; align public and private versions. |
| Independent versions/multiple fixed groups | Deferred until shared versions cause an observed problem. |
| CLI-specific minor versions and other-package patch versions | Rejected; bump according to change significance. |
| Predetermined common layout/additional packages | Inventory first; current game/codecs/assets/config ownership is implemented. Split further only for real consumers. |
| `operations` package or deployment workflows in common | Replaced by the private deployment package. |
| Generic package-discovery application behind `gemwright` | Replaced by the thin CLI wrapper; avoid a second command application. |
| Full OTel/Grafana as an architecture publication gate | Rejected; structure first, complete optional instrumentation afterward. |
| Mandatory collector topology and full dashboard/alert suite | Deferred until instrumentation and actual operational needs exist. |
| Discover arbitrary local/VPS processes or duplicate Railway log storage | Rejected; use known sources and Railway CLI. Local/VPS adapters may be deferred. |
| Every release rebuilds every upstream emulator | Rejected; ordinary builds compile Gemwright artifacts, emulator integration is separate. |
| Guaranteed all-at-once or incremental release schedule | Publication decisions are separate from implementation steps. Current migration target is 0.8.0. |
| Add Nx/Turbo or change package manager to copy reference repositories | Not justified; use native Bun workspaces unless measured limitations require more. |
| Hosted Sphere/MySQL and other emulator acceptance in Step 6 | Deferred by the user; ServUO isolation is the accepted live scope. Preserve existing behavior without claiming hosted validation. |
| Independent VPS client/AI updates and exact registry delivery | Deferred; preserve existing server-led VPS behavior and reject unsupported selections explicitly. |
