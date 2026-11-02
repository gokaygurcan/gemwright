# @gemwright/cli

## 0.9.0

### Minor Changes

- Run the server, web client and AI residents on this machine with Docker Compose: `deploy`, `logs`, `pull` and `restore` accept `--local`, `stop --local` and `start --local` pause and resume parts, and `--server-port`/`--client-port` choose the local ports.

## 0.8.3

No changes in this release.

## 0.8.2

No changes in this release.

## 0.8.1

No changes in this release.

## 0.8.0

### Minor Changes

- [`87f46d4`](https://github.com/gokaygurcan/gemwright/commit/87f46d47d346149d0bbfcbd858380e8aea219168) Thanks [@gokaygurcan](https://github.com/gokaygurcan)! - Split the Node-compatible CLI from the gemwright wrapper and deliver contained Bun AI/client runtimes. Add explicit schema-version compatibility, exact service package selection and independent Railway service updates with persistent resource preservation. Align private workspace versions through the shared Changesets group and make partial publication and release-metadata retries resumable.
