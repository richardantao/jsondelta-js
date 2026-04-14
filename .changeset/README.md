This folder stores release notes for Changesets.

Create a new changeset with:

pnpm changeset

Version packages locally with:

pnpm version-packages

In CI, the release workflow will open or update a release PR from pending changesets and publish to npm from `main` after that PR is merged.
