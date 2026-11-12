# Workflows

GitHub Actions for this repo. GitHub reads only the `.yml` files here, so this README is ignored by Actions.

| Workflow | File | Runs on | Publishes anything? |
|----------|------|---------|---------------------|
| CI | [ci.yml](ci.yml) | Every PR into `main`, every push to `main` | Yes, the API image, only on push to `main` and only if its Trivy scan is clean |
| CodeQL | [codeql.yml](codeql.yml) | Every PR into `main`, every push to `main`, Mondays 03:00 UTC | No, findings go to the Security tab |

Both cancel a run that is still going when a newer push lands on the same branch.

## CI (`ci.yml`)

Three jobs. `test` and `app` run in parallel. `image` runs only after both have passed.

```
PR or push ──┬── test  (API) ──┐
             └── app   (Expo) ─┴── image: build → Trivy scan → publish (push to main only)
```

### `test`: Type check and test the API

Runs in `api/`, with a throwaway Postgres 17 service holding the `portfolio_test` database.

| Step | Command | Catches |
|------|---------|---------|
| Install | `npm ci` | A lockfile that doesn't match `package.json` |
| Type check | `npm run typecheck` | Type errors in `src/`, `test/`, `scripts/` |
| Lint | `npm run lint` | Promises nobody awaits (a query can land after `COMMIT`), misused promises. Unused variables are only warnings |
| Build | `npm run build` | A broken esbuild bundle: the same `dist/server.mjs` the Docker image runs |
| Test | `npm test` | Failing vitest tests, run against the service database (`TEST_DATABASE_URL`) |
| Audit | `npm audit --omit=dev --audit-level=high` | A high or critical advisory in a package the server ships (dev tools excluded) |

### `app`: Check and build the app

Runs at the repo root.

| Step | Command | Catches |
|------|---------|---------|
| Install | `npm ci` | A lockfile that doesn't match `package.json` |
| Type check | `npm run typecheck` | Type errors in the app (`api/` and `scraper/` are excluded) |
| Lint | `npm run lint` (`expo lint`) | ESLint errors. The React Compiler rules are only warnings, see [eslint.config.js](../../eslint.config.js) |
| Web build | `npx expo export --platform web` | Metro errors that `tsc` can't see: bad imports, missing `.web.tsx` files. No `EXPO_PUBLIC_*` values are needed for this |
| Audit | `npm audit --omit=dev --audit-level=critical` | A critical advisory. Critical only, because firebase pulls in `@grpc/grpc-js` (high, Node-only, never loaded in the browser) and npm's only "fix" is downgrading firebase to v9 |

### `image`: Build, scan and publish the API image

Runs on every PR and push, only when `test` and `app` have both passed. A PR builds and scans the image; only a push to `main` (a merged PR) publishes it.

- Builds `api/Dockerfile` with Buildx, using the GitHub Actions cache, into the runner's Docker.
- Scans that image with [Trivy](https://trivy.dev): Alpine's packages and every npm package inside the image. A **high or critical** vulnerability **that already has a fix** fails the job, so nothing is published. Ones with no fix yet are reported in the log but don't fail it (nothing to do about them but wait).
- On a push to `main`: pushes the same build to `ghcr.io/<owner>/<repo>-api` with two tags, `latest` and the short commit sha. Every layer comes from the scanned build, so nothing is rebuilt.
- Logs in with the built-in `GITHUB_TOKEN`, so there are no secrets to set up.

When Trivy fails the job:

1. Read the table in the step's log: which package, which path, which fixed version.
2. In `app/node_modules/`: update that dependency (or the one that pulls it in) in `api/package.json`.
3. In Alpine's packages: a newer `node:22-alpine` usually has it. Re-run the job; Buildx pulls the base image again when it changed.
4. Not reachable and no fix you can take: add the CVE id to an `api/.trivyignore` with a comment saying why and until when, and pass it with `trivyignores`. Don't lower the severity or turn `exit-code` off.

The image has no package manager: npm, npx, corepack and yarn are removed in the last stage of `api/Dockerfile`. The server never runs them, and Trivy's first run found high CVEs only in npm's own bundled packages. Migrations run `node_modules/.bin/node-pg-migrate` directly.

## CodeQL (`codeql.yml`)

Static security analysis of all the JavaScript and TypeScript in the repo (app and API), using the `security-extended` query suite. It reads the source directly, with no build step. It also runs once a week so new queries cover code nobody has touched. Findings appear on the PR and in the repo's **Security → Code scanning** tab. It is free because the repo is public.

What it blocks:

- **A finding never fails this workflow.** The job fails only if the analysis itself breaks, so a green CodeQL run can still have open alerts. Check the Security tab, not the run's color.
- **On a PR**, GitHub adds a separate "Code scanning results" check that fails when the PR brings a new alert of high severity or above.
- **A direct push to `main` is not checked that way.** Until branch protection is on, look at the Security tab after a push.

A false positive (for example a regex in a test that CodeQL reads as a URL check) is dismissed in the Security tab with a reason (`Used in tests` or `False positive`) and a comment that says why. Don't hide it by changing the workflow or excluding paths.

## Checks that are repo settings, not workflows

- **Secret scanning and push protection** are on. A push that contains a known secret format (API keys, tokens) is blocked.
- **Branch protection on `main`** is not set up. Without it, a red CI run reports the problem but doesn't block the merge, and a new CodeQL alert blocks nothing.

## Run the same checks locally

```bash
# API
cd api
npm ci && npm run typecheck && npm run lint && npm run build && npm test   # tests need: docker compose up -d db (with the port override, README "For development")

# App
npm ci && npm run typecheck && npm run lint && npx expo export --platform web
```

## Changing a workflow

- Pin actions to a major version (`@v5`), as the files already do. Every action runs on Node 24; when GitHub warns that one targets an older Node, move it to the major that runs on 24.
- The exception is `aquasecurity/trivy-action`: pinned to a full commit sha with the version in a comment, and the Trivy binary pinned with `version:`. Its tags were hijacked in March 2026 ([GHSA-69fq-xp46-6x23](https://github.com/aquasecurity/trivy/security/advisories/GHSA-69fq-xp46-6x23)), so a tag can't be trusted to stay the code we checked. To update it, take the sha of the new release's tag (`git ls-remote https://github.com/aquasecurity/trivy-action refs/tags/vX.Y.Z^{}`).
- Jobs run on `ubuntu-24.04`, not `ubuntu-latest`, so the runner image changes only when we change it here (`ubuntu-latest` moves to Ubuntu 26 from October 2026). Move all four jobs together, in a PR of their own.
- New job permissions go on the job, not the workflow. The workflow default is `contents: read`.
- If a job's name changes and branch protection is later turned on, update the required checks to match.
