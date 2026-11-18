# Contributing / releasing

1. Branch from `main`, open a pull request, wait for green CI and a review before merging.
2. Add the change under `## [Unreleased]` in `CHANGELOG.md` (Added / Changed / Fixed / Removed).
3. To release: rename Unreleased to the new version, set the same version in `package.json`
   (MAJOR breaking, MINOR new feature, PATCH fix), merge, then tag `vX.Y.Z` (or run the workflow with release=true).
   The pipeline publishes the release with that changelog section and refuses to overwrite an existing version.
