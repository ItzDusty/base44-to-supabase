# base44-to-supabase

A migration and portability tool that helps teams move Base44-based applications to Supabase (cloud or local) while preserving application intent and removing runtime dependency on the Base44 SDK.

This project is designed to be neutral and practical: Base44 can be a productive platform for building apps quickly. Some teams, however, want stronger backend ownership, portability, and the option to run a Supabase-backed environment locally during development. This repo aims to help with that transition.

## Get started

Prerequisites:

- Node.js 20+
- Git
- pnpm (recommended via Corepack)

Install and build:

```bash
git clone https://github.com/ItzDusty/base44-to-supabase.git
cd base44-to-supabase
corepack enable
pnpm install
pnpm -r build
```

Run the interactive flow (recommended):

```bash
node packages/cli/dist/index.js start <path-or-git-url>
```

It creates a migrated **copy** in a new output folder, then runs `analyze`, prompts for a few choices, runs `convert`, and optionally runs `init-supabase`.

Then verify you’re fully off Base44:

```bash
node packages/cli/dist/index.js verify <migrated-project-path>
```

## What this does

- **Analyze** a codebase for Base44 SDK imports and usage patterns.
- **Convert (conservatively)** by removing Base44 SDK imports, generating a vendor-neutral backend adapter entrypoint, and rewriting a set of common call patterns to `backend.*`.
- **Initialize Supabase** assets by generating SQL migrations and safe-by-default RLS policy templates based on best-effort inference. Optionally generates Edge Function stubs when server-function-like calls are detected.

After `convert`, the tool also flags any remaining Base44 module references (including `require('...')` / `import('...')`) as TODOs in the report.

## What this does NOT do

- It does **not** guarantee a fully automated migration.
- It does **not** attempt to perfectly infer schemas, relationships, or authorization rules.
- It does **not** rewrite every call site in your application. It targets common patterns and records TODOs for anything ambiguous.

You should expect a short round of manual follow-up, especially around authorization, row-level security, and any app-specific server-side logic.

In practice: for many apps, this can remove the Base44 SDK as a runtime dependency and get you compiling/running on Supabase quickly — but it is not a 100% automatic “one-click” migration for every codebase.

## Who this is for

- Developers maintaining a Base44-based application who want to adopt **Supabase** as the backend.
- Teams that want **local development** using Supabase local, while keeping a path to Supabase cloud.
- Teams who want a clear, explicit **adapter layer** so backend implementation details are isolated.

## Typical migration flow

1. `start` to create a working copy and walk you through key decisions.
2. Internally it runs `analyze` to identify Base44 SDK imports and usage categories.
3. It runs `convert` to remove Base44 imports, add a generated backend entry (default `src/backend/index.ts`), create `.env.example`, and rewrite common Base44 auth/CRUD/storage calls to `backend.*`.
4. Optionally it runs `init-supabase` to generate `supabase/migrations/*.sql` and safe-by-default RLS policy templates. If server-function-like calls are inferred, it can generate Edge Function stub folders under `supabase/functions/`.
5. Run `verify` (recommended for CI) to ensure there are no remaining Base44 module references.
6. Manually:
   - Adjust the adapter entry (`src/backend/index.ts`) for your environment (cloud vs local).
   - Refine SQL column types and add indexes/constraints.

- Finish login/route protection in your UI and write RLS policies that match your product requirements.

Advanced (non-interactive) commands:

```bash
node packages/cli/dist/index.js analyze <path>
node packages/cli/dist/index.js convert <path> --backend-mode supabase --backend-entry src/backend/index.ts --env-example .env.example
node packages/cli/dist/index.js init-supabase <path>
node packages/cli/dist/index.js verify <path>
```

Each command writes `base44-to-supabase.report.json` to the target project.

## Verification

If you want a hard “are we fully off Base44?” check (useful in CI), run:

```bash
node packages/cli/dist/index.js verify <path>
```

It exits with a non-zero code if any `import ... from 'base44'`, `require('base44')`, or `import('base44')`-style references remain.

## Auth and authorization (customer guide)

This tool helps you **remove Base44 SDK usage** and route calls through a Supabase-backed adapter (`backend.*`). It does **not** fully build your application’s login UI or authorization model for you.

What you get automatically:

- Code rewrites for common auth calls to `backend.auth.*`.
- A generated adapter entry that reads Supabase env vars.
- Supabase SQL scaffolding (migrations + safe-by-default RLS policy templates) when you run `init-supabase`.

What you still need to do (usually quick, but app-specific):

- Build or wire up your **login UI** (email/password and/or OAuth).
- Configure Supabase **Auth providers** and **redirect URLs**.
- Decide your authorization strategy and finalize **Row Level Security (RLS)** policies.

### Step 1: enable Supabase Auth

In your Supabase project dashboard:

- Enable the sign-in methods you want (email/password, Google, GitHub, etc.).
- Set redirect URLs for your local and production environments.

Your app code is responsible for when/where users sign in, and how you protect routes.

### Step 2: add a login flow in your app

The adapter exposes a minimal surface:

- `backend.auth.signIn(...)`
- `backend.auth.signOut()`
- `backend.auth.getUser()`

Example (pseudo-UI code):

```ts
await backend.auth.signIn({ email, password });
const user = await backend.auth.getUser();
if (!user) throw new Error('Not signed in');
```

### Step 3: implement authorization with RLS (recommended)

Supabase authorization is typically enforced with **RLS policies**.

- Run `init-supabase` to generate migrations + policy templates.
- Choose an owner column (for example `owner_id`) when generating templates.
- Treat the generated policies as a starting point—review and adjust to match your product.

If you need server-only administrative operations, do them in server-side code (or Edge Functions) using a service-role key. Do not ship service-role keys to the browser.

### Customer checklist (common path)

- Run `start` to create a migrated working copy.
- Run `verify` to confirm there are no remaining Base44 module references.
- Configure Supabase Auth providers + redirect URLs.
- Implement login + route protection in your UI.
- Review and finalize RLS policies before enabling them.

## Supabase local vs cloud

- **Local** is ideal for development and CI workflows.
  - Use the Supabase CLI (`supabase start`, `supabase db reset`) and iterate quickly.
- **Cloud** is ideal for hosted environments.
  - Configure `SUPABASE_URL` and `SUPABASE_ANON_KEY`.
  - Apply migrations using your preferred approach.

## Adapter design

The adapter is intentionally small and opinionated:

- `auth`: `signIn`, `signOut`, `getUser`
- `data`: `create`, `read`, `update`, `delete`
- `storage`: `upload`, `download`

If your app uses additional capabilities (realtime, RPC, edge functions), expect to extend the adapter and update the conversion TODOs accordingly.

## Limitations and manual steps

- **Entity inference is best-effort.** It currently looks for common `create`/`update` patterns.
- **Conversion is conservative.** If a transform cannot be performed safely (e.g., dynamic entity names, uncommon method signatures), the tool adds TODOs and records them in the report.
- **Edge Function stubs are placeholders.** They help you organize work, but you still need to implement server-side logic and permissions.
- **Security is app-specific.** Generated RLS policies are templates and default to “review before enabling.”

## Respectful note about Base44

Base44 can be a great way to build an app quickly. This project exists for teams whose needs change over time—e.g., they want to own their backend implementation details, run local environments, or standardize on Supabase.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
