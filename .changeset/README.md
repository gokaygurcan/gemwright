# Changesets

Releases of the `gemwright` CLI are driven by [Changesets](https://changesets.dev). The other
workspace packages are private and are never versioned or published.

When a change should reach npm users, add a changeset with it:

```sh
bun changeset
```

Pick `gemwright`, the bump (patch, minor or major) and write the line that should appear in the
release notes. Commit the generated file with the change.

On `main`, the release workflow keeps a "Release gemwright" pull request open with the pending
changesets applied (version bump and `packages/gemwright/CHANGELOG.md`). Merging it publishes that
version to npm and creates the `gemwright@<version>` GitHub release from its changelog entry.
