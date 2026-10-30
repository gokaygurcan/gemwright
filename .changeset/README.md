# Changesets

All Gemwright packages share a version. Private packages are versioned but never published or tagged. Public internal runtime dependencies use exact matching versions.

```sh
bun changeset               # Describe substantive changes, including private packages
bun run version-packages    # Apply changesets and refresh the lockfile
```

The workflow opens the version PR. After merge it validates packed applications, publishes missing public versions in dependency order, then creates tags/GitHub releases once every publication succeeds.

For a partial release, rerun failed jobs at the same commit. Published versions are skipped; missing versions use the original packed artifacts. Metadata-only retries do not republish. Registry/GitHub lookup errors stop the job.

Artifacts are retained for 30 days. If they expire, decide recovery explicitly rather than changing versions or silently rebuilding. Each public package needs registry ownership and publication authentication; publishing does not deploy services.
