# deployRocket

Production-oriented mobile-first web app for creating, updating, committing, and deploying AI-generated software projects from a phone.

This is not a chat app. The chat-like composer is only used to create or edit structured project input. After submission, the app moves into the project orchestration dashboard and live project status flow.

## What It Does

- Accepts text, browser voice transcription, and image uploads.
- Processes raw input into structured software requirements with OpenAI.
- Builds a Codex implementation prompt.
- Uses a Codex coding model through the OpenAI Responses API to generate real project files.
- Creates or updates a GitHub repository through OAuth.
- Commits generated files to GitHub.
- Configures GitHub Pages with a GitHub Actions deployment workflow.
- Polls real GitHub Actions and Pages state until the project is live or failed.
- Persists projects, actions, errors, inputs, deployment history, and OAuth state in local JSON files.

There is no mock mode and no fake status path. Missing credentials, invalid tokens, Codex failures, GitHub errors, and deployment failures are stored as readable project errors.

## Stack

- React
- Vite
- TypeScript
- TailwindCSS
- Express
- Local JSON persistence
- GitHub OAuth
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

Fill in `.env` before creating projects.

## Environment Variables

```bash
PORT=3000

OPENAI_API_KEY=

GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GITHUB_CALLBACK_URL=http://localhost:3000/auth/github/callback

SESSION_SECRET=

GITHUB_DEFAULT_BRANCH=main
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

The app requests these OAuth scopes:

- `repo`
- `workflow`
- `user:email`

The repository is created as public by default so GitHub Pages can deploy without requiring a paid private Pages setup.

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

## Local Persistence

Runtime data is written under:

```text
data/db.json
data/auth.json
data/generated/
uploads/
```

These paths are ignored by git. Existing projects persist after backend restart. If the backend restarts during an active run, the app marks the interrupted project as `STOPPED` with a readable action history entry.

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
