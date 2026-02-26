# BundleCheck Size Audit Action

Audit npm package bundle sizes against gzip budgets in CI.

This action sends an exact `name@version` package list to the BundleCheck API, reports per-package and total gzip size, posts or updates a PR comment, and can fail the workflow when budgets are exceeded.

## What It Does

- Audits exact npm package versions (for example `react@18.2.0`)
- Enforces optional budgets:
  - per package (`per_package_gzip`)
  - total sum (`total_gzip`)
- Supports async processing for large package lists
- Upserts a single PR comment with results
- Exposes outputs for downstream workflow steps

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `api_key` | Yes | - | BundleCheck API key (`X-API-Key`) |
| `packages` | Yes | - | Newline-separated exact `name@version` list |
| `per_package_gzip` | No | - | Per-package gzip budget in bytes |
| `total_gzip` | No | - | Total gzip budget in bytes (sum of individual package costs) |
| `fail_on_violation` | No | `true` | Fail when budget violations are found |
| `fail_on_partial` | No | `false` | Fail when any package could not be bundled (`denied`, `not_found`, `timeout`, `error`) |
| `warn_only` | No | `false` | Always exit 0 even if violations are found |
| `github_token` | No | `${{ github.token }}` | Token used to post/update PR comment |
| `api_url` | No | `https://bundlecheck.dev` | Override API base URL |
| `poll_interval_seconds` | No | `3` | Poll interval for async audits |
| `poll_timeout_seconds` | No | `300` | Max wait time for async audits |

## Outputs

| Output | Description |
|---|---|
| `pass` | `true` or `false` based on audit result |
| `total_gzip` | Sum of gzip sizes across successfully bundled packages (bytes) |
| `violation_count` | Number of per-package violations (excludes total line item) |

## Usage

```yaml
name: BundleCheck

on:
  pull_request:

permissions:
  contents: read
  pull-requests: write

jobs:
  bundlecheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Run BundleCheck audit
        id: audit
        uses: venwork-dev/bundlecheck-audit-action@v1
        with:
          api_key: ${{ secrets.BUNDLECHECK_API_KEY }}
          packages: |
            react@18.2.0
            axios@1.6.7
          per_package_gzip: 50000
          total_gzip: 120000
          fail_on_violation: true
          fail_on_partial: false
          warn_only: false

      - name: Print summary
        run: |
          echo "pass=${{ steps.audit.outputs.pass }}"
          echo "total_gzip=${{ steps.audit.outputs.total_gzip }}"
          echo "violations=${{ steps.audit.outputs.violation_count }}"
```

## Notes

- `total_gzip` is the sum of individual package costs. It is not your real app bundle size (no deduplication/tree-shaking modeling).
- For large batches, the API may return `202` and the action will poll until completion.
- Outside pull request context, the action logs the rendered report instead of posting a PR comment.

## Versioning

Use major tags in consumer workflows:

```yaml
uses: venwork-dev/bundlecheck-audit-action@v1
```

This repository publishes immutable release tags (`vX.Y.Z`) and keeps the floating major tag (`vX`) updated to the latest compatible release.

## Releasing This Action

Use the `Release` workflow in this repository:

1. Run `Release` via `workflow_dispatch`
2. Provide a semantic version (`1.2.3` or `v1.2.3`)

The workflow will:

- Rebuild `dist/`
- Commit `dist/` to `main` if needed
- Create immutable tag `vX.Y.Z`
- Update floating major tag `vX`
- Create a GitHub Release with generated notes

Marketplace publication is a manual GitHub UI step on the created release.

## Development

```bash
bun install
bun run typecheck
bun run build
```

`dist/index.js` is committed for GitHub Action runtime consumption.
