# Contributing

Thanks for helping improve `base44-to-supabase`.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Goals

- Keep the project neutral and technical.
- Prefer conservative transforms that avoid breaking user code.
- When unsure, add a TODO + report entry rather than guessing.

## Development

```bash
pnpm install
pnpm -r build
pnpm test
pnpm lint
```

## Project structure

- `packages/cli`: CLI (`commander`)
- `packages/codemods`: analysis + transforms (`ts-morph`)
- `packages/adapter`: vendor-neutral backend interface
- `packages/adapter-supabase`: Supabase implementation
- `packages/adapter-local`: local Supabase convenience wrapper

## Pull requests

- Keep PRs focused and easy to review.
- Add or update lightweight tests when practical (`vitest`).
- Avoid changing formatting in unrelated files.
