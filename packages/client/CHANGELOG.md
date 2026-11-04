# @gemwright/client

## 0.10.0

### Patch Changes

- [`8872cc9`](https://github.com/gokaygurcan/gemwright/commit/8872cc9c1d5ab0109f47aac7e35376a299f28682) Thanks [@gokaygurcan](https://github.com/gokaygurcan)! - The browser runtime moves to uonexus-minimal v1.0.67.

## 0.9.0

### Patch Changes

- Update the AI and web client log export to OpenTelemetry 3 (`sdk-logs` and `resources` 3.0.0, `exporter-logs-otlp-http` 0.300.0).

## 0.8.3

No changes in this release.

## 0.8.2

No changes in this release.

## 0.8.1

No changes in this release.

## 0.8.0

### Minor Changes

- [`87f46d4`](https://github.com/gokaygurcan/gemwright/commit/87f46d47d346149d0bbfcbd858380e8aea219168) Thanks [@gokaygurcan](https://github.com/gokaygurcan)! - Split the Node-compatible CLI from the gemwright wrapper and deliver contained Bun AI/client runtimes. Add explicit schema-version compatibility, exact service package selection and independent Railway service updates with persistent resource preservation. Align private workspace versions through the shared Changesets group and make partial publication and release-metadata retries resumable.
