# Releasing

This is a single-package npm repository.

## First Publish Bootstrap

1. Confirm the final npm package name.
2. Set the canonical GitHub repository URL in `package.json`:
   - `repository`
   - `homepage`
   - `bugs`
3. Run the local checks:

   ```bash
   npm run check
   npm run pack
   npm run publish:dry-run
   ```

4. Publish the first version manually:

   ```bash
   npm publish --provenance
   ```

5. Configure npm Trusted Publishing for the package.

## Ongoing Releases

After the first manual publish and Trusted Publishing setup:

```bash
npm run release:patch
```

or:

```bash
npm run release:minor
npm run release:major
```

The release script runs checks, creates an `npm version` commit and `v*` tag,
then pushes the commit and tag. `.github/workflows/publish.yml` publishes only
on explicit `v*` tags or manual dispatch.

## npm Trusted Publishing Settings

Fill these in after the canonical GitHub repository is known:

- GitHub user or organization: TBD
- Repository: TBD
- Workflow filename: `publish.yml`
- Environment: none
