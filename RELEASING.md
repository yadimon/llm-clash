# Releasing

This is a single-package npm repository.

## First Publish Bootstrap

1. Confirm the final npm package name: `@yadimon/llm-clash`.
2. Confirm the canonical GitHub repository URL:
   `https://github.com/yadimon/llm-clash`.
3. Run the local checks:

   ```bash
   npm run check
   npm run pack
   npm run publish:dry-run
   ```

4. Publish the first version manually:

   ```bash
   npm publish --access public
   ```

5. Configure npm Trusted Publishing for the package.

   You can configure it in the npm web UI with the settings below, or with a
   current npm CLI:

   ```bash
   npm install -g npm@latest
   npm trust github @yadimon/llm-clash --repo yadimon/llm-clash --file publish.yml
   ```

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
on explicit `v*` tags after Trusted Publishing is configured.

## npm Trusted Publishing Settings

Fill these in after the first manual publish:

- GitHub user or organization: `yadimon`
- Repository: `llm-clash`
- Workflow filename: `publish.yml`
- Environment: none
