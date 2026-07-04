# Releasing

1. Bump `version` in `package.json`.
2. Run `npm publish --dry-run` and inspect the file list. It should contain
   `bin/`, `dist/`, `README.md`, `LICENSE`, and `package.json`.
3. Run `npm publish`.

The `prepack` script runs automatically for `npm pack`, `npm publish`, and
their dry runs. It builds with `LLV_STANDALONE=1`, copies `.next/standalone` to
`dist/standalone`, and copies `.next/static` into
`dist/standalone/.next/static`.

Observed `npm pack --dry-run` output lists package-relative paths such as
`dist/standalone/server.js`; those are the paths inside the tarball.
