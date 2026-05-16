# deployRocket

Production-oriented mobile-first web app for creating, updating, committing, and deploying AI-generated software projects from a phone.

This is not a chat app. The chat-like composer is only used to create or edit structured project input. After submission, the app moves into the project orchestration dashboard and live project status flow.

## What It Does

- Accepts text, browser voice transcription, and image uploads.
- Processes raw input into structured software requirements with OpenAI.
- Builds a Codex implementation prompt.
- Uses a Codex coding model through the OpenAI Responses API to generate real project files.
- Creates or updates a GitHub repository in the connected customer GitHub account through OAuth.
- Commits generated files to GitHub.
- Configures GitHub Pages with a GitHub Actions deployment workflow.
- Polls real GitHub Actions and Pages state until the project is live or failed.
- Stores project status, prompts, architecture, actions, errors, and deployment history in each project repo on the `deployrocket-state` branch.

There is no mock mode and no fake status path. Missing credentials, invalid tokens, Codex failures, GitHub errors, and deployment failures are written as readable project errors in the GitHub dossier.

## Stack

- React
- Vite
- TypeScript
- TailwindCSS
- Express
- GitHub-owned project state with `deployrocket-state` README dossiers
- GitHub OAuth with per-session customer authorization
- OpenAI Responses API with a Codex coding model
- GitHub REST API and GitHub Pages Actions deployment

## Requirements

- Node.js 20 or newer
- npm
- OpenAI API key with access to the configured model
- GitHub account
- GitHub OAuth App

## Installation

```bash
npm install
cp .env.example .env
```

Fill in `.env` before creating projects. Do not commit `.env`; the committed `.env.example` only documents the required settings.

## Environment Variables

```bash
PORT=3000

OPENAI_API_KEY=

# GitHub OAuth app credentials for this deployRocket installation.
# These identify the app, not the customer's GitHub account.
# Each customer connects and deploys with their own GitHub account.
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GITHUB_CALLBACK_URL=http://localhost:3000/auth/github/callback

SESSION_SECRET=

GITHUB_DEFAULT_BRANCH=main

# Serverless mode exports the API as a function and stores project state in GitHub.
SERVERLESS=false
GITHUB_PROJECT_TOPIC=deployrocket-project
GITHUB_STATE_BRANCH=deployrocket-state

# Comma-separated frontend origins allowed to call the API.
# Origins do not include paths. For GitHub Pages use: https://YOUR_USERNAME.github.io
FRONTEND_ORIGIN=http://localhost:5173,http://127.0.0.1:5173

# Public frontend app URL used after GitHub OAuth redirects.
# For GitHub Pages include the repository path, for example:
# https://YOUR_USERNAME.github.io/deployRocket/
FRONTEND_URL=

# Public backend URL used by the static GitHub Pages frontend.
# Leave empty for local same-origin/dev-proxy usage.
VITE_API_BASE_URL=
```

Optional model overrides:

```bash
OPENAI_MODEL=gpt-5.2
OPENAI_CODEX_MODEL=gpt-5.2-codex
```

## GitHub OAuth Setup

1. Open GitHub Developer settings.
2. Create a new OAuth App.
3. Set Homepage URL to `http://localhost:5173` for local development.
4. Set Authorization callback URL to `http://localhost:3000/auth/github/callback`.
5. Copy the client ID and client secret into `.env`.
6. Set `SESSION_SECRET` to a long random value.

The OAuth app credentials are infrastructure configuration for the deployRocket installation. They are not your personal deployment target, and they should never be committed. When a customer clicks Connect GitHub, GitHub issues an access token for that customer session; repositories, commits, Actions, and Pages deployments are created in that connected customer account.

The app requests these OAuth scopes:

- `repo`
- `workflow`
- `user:email`

The repository is created in the connected customer account. It is public by default so GitHub Pages can deploy without requiring a paid private Pages setup.

## Serverless Deployment

deployRocket can run as a serverless Vercel app. The React frontend is static, and the API is exposed through `api/index.ts`. The app does not require a database: each customer project is a GitHub repository tagged with `deployrocket-project`, and its live state is stored in a human-readable `README.md` on the repo's `deployrocket-state` branch.

Recommended Vercel environment:

```bash
SERVERLESS=true
GITHUB_PROJECT_TOPIC=deployrocket-project
GITHUB_STATE_BRANCH=deployrocket-state

OPENAI_API_KEY=
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GITHUB_CALLBACK_URL=https://your-vercel-app.vercel.app/auth/github/callback
SESSION_SECRET=your-long-random-secret
FRONTEND_ORIGIN=https://your-vercel-app.vercel.app
FRONTEND_URL=https://your-vercel-app.vercel.app/
```

For same-origin Vercel hosting, leave `VITE_API_BASE_URL` empty. If you keep the frontend on GitHub Pages and use Vercel only for the API, set `VITE_API_BASE_URL=https://your-vercel-app.vercel.app`, set `FRONTEND_ORIGIN=https://your-github-username.github.io`, and set `FRONTEND_URL=https://your-github-username.github.io/deployRocket/`.

Update the GitHub OAuth App callback URL to the same `GITHUB_CALLBACK_URL` value. Serverless orchestration advances through the polling endpoint `POST /api/projects/:id/run`, so Codex generation, GitHub commits, and Pages deployment status continue without relying on a long-lived Express process.

The dashboard rebuilds itself by searching the connected user's GitHub account for repositories with the `deployrocket-project` topic, then reading the dossier README from `deployrocket-state`. Generated project code remains on `main`; deployRocket status updates stay off the deployment branch.

## Deploying A Separate Backend

GitHub Pages only hosts the static React frontend. It cannot run the Express API, OAuth callback, OpenAI calls, or GitHub orchestration. If you do not use the Vercel serverless setup, run the backend on Render, Railway, Fly.io, a VPS, or another Node-capable host.

Set the hosted backend origin in the frontend build as:

```bash
VITE_API_BASE_URL=https://your-backend.example.com
```

Also update the GitHub OAuth App callback URL and backend .env to match the hosted backend:

```bash
GITHUB_CALLBACK_URL=https://your-backend.example.com/auth/github/callback
FRONTEND_ORIGIN=https://your-github-username.github.io
FRONTEND_URL=https://your-github-username.github.io/deployRocket/
```

`FRONTEND_ORIGIN` is only the origin, without `/deployRocket`. `FRONTEND_URL` is the full app URL used after GitHub login. In production the backend should run on HTTPS so browser session cookies work across the GitHub Pages frontend and the API server.

If the static frontend is deployed by the included GitHub Actions workflow, set a repository Actions variable named `VITE_API_BASE_URL` to your hosted backend URL, then rerun the Pages workflow.

Local development can leave `VITE_API_BASE_URL` empty because Vite proxies `/api` and `/auth` to `localhost:3000`.

## GitHub Pages Setup

No manual Pages setup is normally required after OAuth is connected.

For each generated project, the backend:

1. Creates or reuses the project repository.
2. Commits generated Vite React TypeScript files.
3. Commits `.github/workflows/pages.yml`.
4. Enables Pages with workflow deployment.
5. Dispatches or waits for the Pages workflow.
6. Polls the workflow and retrieves the Pages URL.

If deployment fails, open the project detail screen and inspect the error panel and action history. The workflow URL is stored in deployment history.

## Running Locally

Run backend and frontend together:

```bash
npm run dev
```

Frontend:

```bash
npm run dev:client
```

Backend:

```bash
npm run dev:server
```

Open:

```text
http://localhost:5173
```

The backend runs on:

```text
http://localhost:3000
```

## Production Build

```bash
npm run build
npm start
```

After `npm run build`, Express serves the compiled frontend from `dist/client`.

## GitHub Project Memory

Runtime project memory is owned by the connected customer's GitHub account. Each deployRocket project is a GitHub repository tagged with `deployrocket-project`. The generated app code lives on the normal deployment branch, while deployRocket writes status and orchestration memory to:

```text
branch: deployrocket-state
file: README.md
optional generated snapshot files: generated/*.json
```

The dossier README contains a stable `deployrocket-state-json` block for agents plus readable sections for current stage, completion, original prompt, architecture, action history, deployment URL, and latest errors. GitHub OAuth tokens are stored only in encrypted HttpOnly browser cookies, not in app storage.

## Project Lifecycle

Statuses are persisted as the real workflow advances:

- `IDLE`
- `PROCESSING_INPUT`
- `GENERATING_PROMPT`
- `SENDING_TO_CODEX`
- `CODEX_WORKING`
- `SAVING_TO_GITHUB`
- `DEPLOYING`
- `LIVE`
- `FAILED`
- `STOPPED`

The frontend automatically polls while the dashboard or project screen is open. Manual refresh is also available on the project detail screen.

## Edit Flow

Open a project and tap Edit. If the project is running, the app shows:

```text
The project is currently running.
Editing will stop the current process.
```

Choosing Stop and Continue aborts the active controller, persists `STOPPED`, opens the same input interface, and starts a full regenerate, recommit, and redeploy flow after submission.

## Stop Flow

Stop aborts the in-memory orchestration controller and persists `STOPPED`. The backend checks for stopped state between each major step so it does not continue into GitHub commit or deployment after a stop request.

## Development Flow

Useful commands:

```bash
npm run typecheck
npm run build
```

The backend code lives in `src/server`.

The frontend code lives in `src/client/src`.

Shared project types live in `src/shared/types.ts`.

Core backend agents:

- `inputProcessor.ts`
- `promptArchitect.ts`
- `codexRunner.ts`
- `githubManager.ts`
- `pagesDeployManager.ts`
- `orchestrator.ts`

## Failure Behavior

The app fails gracefully when configuration or real downstream services fail.

Common setup failures:

- Missing `OPENAI_API_KEY`
- Missing GitHub OAuth variables
- GitHub not connected
- Invalid or expired GitHub token
- Missing repository permissions
- GitHub Pages workflow failures
- Codex malformed response
- Empty prompts
- Invalid uploads

Each failure is stored on the project with a code, readable message, optional details, and setup instructions when available.
