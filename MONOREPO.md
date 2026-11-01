# Monorepo architecture and delivery plan

Finish each step before starting the next. This plan does not itself authorize publication or deployment. Preserve unrelated working-tree changes.

## Decisions

1. Prioritize Railway, then local, then VPS. Preserve existing local/VPS behavior without building another deployment platform.
2. Packages need clear ownership and useful standalone behavior. Publish only packages with a useful public application or API; private packages are valid long-term.
3. Use one shared version for every package, including private packages. Changesets aligns versions; only public packages publish. Fixes use patch, features use minor, and breaking changes use minor before 1.0 or major afterward. The package name does not determine the bump.
4. Develop and build with Bun. The installed CLI and wrapper support Node 24+ without Bun. AI/client/analyze/network may require Bun 1.4.3+. Common stays runtime-neutral where practical; deployment code used by CLI stays Node-compatible.
5. `@gemwright/cli` owns commands and presentation. `gemwright` delegates directly to its exact matching version in the same process. Bins are `gemwright-cli` and `gemwright`; preserve `npx gemwright`, arguments, signals and exit codes.
6. Use one root tsconfig. Root `bun run build` uses native Bun workspace ordering; no Turbo, custom build orchestrator, extra root configs or verification command family. Package scripts compile directly; source helpers handle only CLI asset copying and client asset compression.
7. Public applications bundle required private workspace code. No unpublished runtime dependency or unresolved `workspace:` range may require an npm consumer to access this repository. Internal public runtime dependencies use exact matching versions.
8. Use `schemaVersion` in `gemwright.json`, one JSON Schema and internal component compatibility rules in common. Missing schemaVersion means 1. Validate before mutation. Unknown schemas, unsupported versions and malformed configuration fail with an update command. Add migration tooling only when a real migration needs it.
9. AI, client and server own separate services and processes. Updating one never changes or restarts another. Server runs alone, with either service or with both; client and AI accept explicit compatible counterparts without a CLI-created server. AI supports ServUO only.
10. Select exact published component versions through `gemwright update`; selection changes configuration, not running deployments. Deployment is explicit. Failed retrieval never falls back to another version. Keep CLI-carried artifacts when no version is selected until publication availability supports removing that path.
11. Contained npm packages carry their required build/deployment assets. Railway uses its existing build flow; no separate image registry, release manifest or artifact catalog. Preserve persistent data and resource identities on updates.
12. Require an installed/authenticated Railway CLI. Untested versions warn and attempt the command. Actual command/parse failures remain failures. Never silently install or upgrade the user's CLI.
13. Release retries publish only missing versions in dependency order from original workflow artifacts. Announce only after all intended public publications succeed. Metadata retries repair missing tags/releases without republishing. No custom release database or automatic deployment.
14. Build package boundaries before observability. Standardized logs come next, then complete optional OpenTelemetry. Grafana and other exporters are explicit opt-ins. Exporter failure must not disrupt the application.
15. Keep package READMEs to the shared root header, usage/help or exported configuration, and MIT. Maintain third-party references in the single root third-party file.

## Package ownership

| Package | Owns | Runtime / publication |
| --- | --- | --- |
| `gemwright` | Thin CLI entry point | Node; public |
| `@gemwright/cli` | Commands, prompts, presentation and adapter composition | Node; public |
| `@gemwright/server` | Emulator integration, templates, patches and staging | Node staging; private |
| `@gemwright/client` | Browser payload, HTTP/WebSocket host and owned deployment files | Bun; public |
| `@gemwright/ai` | Resident runtime, persistence and domain event journal | Bun; public |
| `@gemwright/network` | Protocol, sessions, transport, observations and diagnostics hooks | Bun; private |
| `@gemwright/common` | Shared game data, codecs, asset readers, configuration/schema/compatibility | Private source package |
| `@gemwright/deployment` | Deploy/pull/restore, provider adapters and transfer workflows | Node-compatible; private |
| `@gemwright/analyze` | Inspection and reporting | Bun/browser; private |
| Observability (planned) | Logging contracts, context, redaction, instrumentation and exporters | Publication/layout undecided |

Private packages whose names are reserved on npm hold only placeholders; they are never published from this repository.

Common exports `game`, `codecs`, `assets` and `config` subpaths; it does not own deployment workflows. The name `deployment` reflects deploy/pull/restore ownership rather than the broader rejected name `operations`.

Dependency direction: network → common; AI → common/network; client → common; deployment → common/client file contracts; server → common/deployment utilities; CLI composes these owners; analyze → common/deployment. Lower-level packages import neither CLI nor analyze. Deployment receives server adapters rather than importing server. Keep this graph acyclic.

Observability must not depend on AI/network. AI owns domain meanings and journal durability/retention; provider logs and OpenTelemetry do not replace its replay journal. Further package splits require a demonstrated consumer rather than a predetermined folder layout.

## Ordered work

### Step 0 — Working branch

Use `monorepo` for reviewable changes. Preserve public CLI behavior and finish each numbered step before advancing. Publication/commit grouping is separate from implementation order.

### Step 1 — Inventory and ownership

Inventory imports, package/build inputs, runtimes, emulator assets, provider mutations and public candidates. Settle common/deployment ownership and the wrapper approach before extraction. Follow-through, carried out in Steps 2-6: remove analysis-to-CLI imports; separate emulator files from CLI presentation; remove whole-workspace image staging; move AI trust changes to explicit server operations; support explicit counterparts; preserve service/volume identity.

### Step 2 — Shared boundaries and runtime support

Common exports are organized and private deployment workflows extracted. AI/network retain Bun SQLite/TCP/timers; client/analyze retain Bun hosting. CLI builds for Node. Private shared code is bundled by its application owner; no dual-runtime adapter or declaration pipeline. Builds use native workspace ordering without extra root tsconfigs, compiler-output machinery or separate verification commands.

### Step 3 — CLI/server extraction and wrapper

Scoped CLI owns commands and exports `main`/`run`. The wrapper calls the same runner. Server owns emulator integration and exposes `dist/staging.js`; CLI owns questionnaire-based initialization and composes server adapters. Packed installs under Node without Bun must pass help/version, invalid arguments, cancellation/SIGTERM, interactive initialization and every emulator staging path.

### Step 4 — Shared versioning and retryable releases

Changesets uses one fixed group for `gemwright` and `@gemwright/*`, with private versioning enabled and private publication/tags disabled. Root checks run lint, typecheck, native workspace builds and full tests. Upstream emulators are not rebuilt by ordinary package builds.

Release flow: checks → version/publish selection → version PR or build/pack → publish → announcement. `.changeset/release.ts` only refreshes the missing-version plan for original artifacts and reconciles missing GitHub releases. It does not select affected files or orchestrate builds. A private package change aligns every version and keeps the wrapper dependency exact; a partial publication retries only the missing packages; announcement waits for completion; bad artifact integrity and failed registry reads stop publication.

Recovery: rerun failed jobs at the same commit while the original artifacts remain available. Do not change versions/source or rebuild implicitly to recover a partial publication. Decide recovery explicitly if artifacts expire. See `.changeset/README.md` for operating instructions.

### Step 5 — Configuration compatibility

Common owns the JSON Schema and component compatibility checks. Each schema version accepts a stable range of component versions; this is a deployment configuration contract, not a promise that every game protocol is interchangeable. Explicit selections must be exact stable versions.

`gemwright update` reports newer compatible packages and the selection/deploy commands. `gemwright update --ai --package-version <exact>` validates publication and compatibility, then updates only the selected setting. It does not deploy. Configuration validation and unsupported-schema checks precede provider mutation.

### Step 6 — Standalone delivery and Railway isolation (ServUO)

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
- Local/VPS remain server-led. Independent pinned package delivery applies to Railway; VPS rejects unsupported selections rather than substituting another artifact.

Acceptance runs on a disposable Railway project with ServUO, client and AI, never on production identities: provisioning, imports, public TCP and prerequisite failures; a real resident login; resident identity and state surviving component updates and server reconnection; exact AI/client/server updates through an older CLI preserving the other deployments, volumes and managed variables; client readiness before and after import, WebSocket login over private networking and upload retry.

### Step 7 — Publication

Public packages: `gemwright`, `@gemwright/cli`, `@gemwright/ai`, `@gemwright/client`. The others stay private.

1. Review the final tarballs and clean installs: dependency closure, third-party references and exclusion of user data/secrets. The browser input was matched to UO Nexus minimal; details belong in the root third-party file.
2. Every public package exists on npm with this repository's `release.yml`/`npm` environment as its trusted publisher. Do not put tokens in files or chat.
3. Lint/typecheck must pass before commit/deployment; tests before push. Passing a check is not permission to publish.
4. Publish through the agreed release flow and verify package availability and retry behavior. Publication never updates running services.
5. Remove carried artifacts only once the published replacement is available and independent delivery remains usable.

Complete when the public packages are available at the released version, private packages remain unpublished, retry behavior is verified and the outcome is recorded. Local rehearsals alone do not complete it.

### Step 8 — Logging and `gemwright logs`

1. Inventory actual outputs and establish observability ownership for structured logs, context, service/version/deployment identity, redaction and error serialization. Preserve AI journal/replay behavior.
2. Implement `gemwright logs`: all services by default with labels; combinable `--server`, `--client`, `--ai`; `--watch` streams to the current terminal. Use installed Railway CLI log access without storing another centralized copy.
3. Separate operational logs from CLI report stdout. Handle missing services and cancellation. Local/VPS adapters use known managed/configured sources; explicitly defer adapters requiring substantial work.

Complete when Railway logs work without Grafana/OTLP, the agreed flags work and journals remain readable. Record any local/VPS gaps honestly.

### Step 9 — Optional OpenTelemetry

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
| Guaranteed all-at-once or incremental release schedule | Publication decisions are separate from implementation steps. |
| Add Nx/Turbo or change package manager to copy reference repositories | Not justified; use native Bun workspaces unless measured limitations require more. |
| Hosted Sphere/MySQL and other emulator acceptance in Step 6 | Deferred by the user; ServUO isolation is the accepted live scope. Preserve existing behavior without claiming hosted validation. |
| Independent VPS client/AI updates and exact registry delivery | Deferred; preserve existing server-led VPS behavior and reject unsupported selections explicitly. |
