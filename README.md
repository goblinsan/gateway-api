# gateway-api

API layer for the home gateway server — handles requests for services running locally or on the LAN.

## Setup

```bash
npm install
```

## Development

```bash
npm run dev
```

## Build & Run

```bash
npm run build
npm start
```

## Docker

```bash
# Build and start
docker compose up -d

# Rebuild after changes
docker compose up -d --build
```

The Dockerfile uses a multi-stage build that compiles the `ghp` binary from source (Go) and bundles it into the final Node.js image. In production, the container also checks for a host-managed helper at `/opt/host-tools/ghp` so the gateway can pick up fresh `gh-project-helper` builds without rebuilding the API image. Set `GITHUB_TOKEN` in your `.env` file for `ghp` authentication.

## Endpoints

### `GET /health`

Returns `{ "status": "ok" }`.

### `GET /policy`

Returns a public HTML privacy policy page for `api.jimmothy.site`. This endpoint is intentionally unprotected so it can be referenced by external integrations such as GPT Actions.

### `POST /plans-to-project/validate`

Validates a plan YAML file against the `ghp` schema. All `/plans-to-project/*` and `/api/workflows/*` endpoints require an API key when `GATEWAY_API_KEY` is configured. Present it with either `X-API-Key: <key>` or `Authorization: Bearer <key>`.

- **Body**: `multipart/form-data` with a `plan` field containing a `.yaml`/`.yml` file
- **200**: `{ "valid": true, "output": "..." }`
- **422**: `{ "valid": false, "error": "..." }`

### `POST /plans-to-project/preflight`

Runs a non-mutating repo-resolution preflight for a plan YAML file.

- **Body**: `multipart/form-data` with a `plan` field containing a `.yaml`/`.yml` file
- **200**: Structured JSON with one of these statuses:
  - `ready`
  - `invalid`
  - `repo_resolution_required`
  - `create_repo_confirmation_required`

Use this from a Custom GPT or other client before applying when you need a safer approval path.

### `POST /plans-to-project/preflight-from-text`

Runs the same non-mutating repo-resolution preflight, but accepts the plan as JSON text instead of a file upload.

- **Body**:

```json
{
  "planYaml": "project: My Project\nrepository: owner/repo\n"
}
```

- **200**: Structured JSON with one of these statuses:
  - `ready`
  - `invalid`
  - `repo_resolution_required`
  - `create_repo_confirmation_required`

### `POST /plans-to-project/apply`

Applies a plan YAML file to create GitHub project milestones, epics, and issues.

- **Body**: `multipart/form-data` with a `plan` field containing a `.yaml`/`.yml` file
- **Optional field**: `repositoryOverride=owner/repo` to force apply against an existing exact repo chosen during preflight
- **Optional field**: `createRepoIfMissing=true` to allow creating the requested repo when no similar matches were found during preflight
- **Query**: `?dryRun=true` to preview without applying
- **200**: `{ "success": true, "output": "...", "warnings": "..." }`
- **500**: `{ "success": false, "error": "..." }`

### `POST /plans-to-project/plan`

One-call orchestration endpoint intended for a Custom GPT or other planning client.

Behavior:

- Runs the same preflight step first.
- If the repository is an exact match, it applies immediately.
- If similar repositories are found, it returns `409` with `stage: "repo_resolution_required"` and the preflight payload.
- If no similar repositories are found, it returns `409` with `stage: "create_repo_confirmation_required"` unless `createRepoIfMissing=true` is supplied.
- If the plan is invalid, it returns `422` with `stage: "preflight"`.

This lets the client keep the human-in-the-loop confirmation step outside the API while still using a single endpoint for the happy path.

Requires `ghp` binary on `PATH` (or set `GHP_BINARY` env var). GitHub auth is handled by `ghp` via `GITHUB_TOKEN` env var or `~/.gh-project-helper.yaml`.

---

### `POST /plans-to-project/plan-from-text`

JSON/text equivalent of `/plans-to-project/plan`, intended for GPT Actions and other clients that generate YAML in-memory.

- **Body**:

```json
{
  "planYaml": "project: My Project\nrepository: owner/repo\n",
  "repositoryOverride": "owner/similar-repo",
  "createRepoIfMissing": false
}
```

Behavior matches `/plans-to-project/plan`:

- Runs preflight first.
- Returns `409` for `repo_resolution_required` unless `repositoryOverride` is supplied.
- Returns `409` for `create_repo_confirmation_required` unless `createRepoIfMissing=true` is supplied.
- Returns `422` if the plan is invalid.
- Applies immediately on the exact-match happy path.

### `POST /api/assets`

Uploads one or more binary or image assets into a GitHub repository via the GitHub Contents API.

- **Auth**: requires `X-API-Key` or `Authorization: Bearer` when `GATEWAY_API_KEY` is configured
- **Body**: `multipart/form-data`

| Field | Required | Description |
|---|---|---|
| `assets` | ✅ | One or more files attached under the `assets` field |
| `repository` | ✅ | Target GitHub repository in `owner/repo` format |
| `destinationPath` | ✅ | Relative directory path inside the repository (e.g. `docs/images`) |
| `branch` | optional | Target branch (default: `main`) |
| `overwrite` | optional | `true` to replace existing files (default: `false`) |
| `commitMessage` | optional | Git commit message (default: `Upload assets`) |

**Status codes**

| Status | Meaning |
|---|---|
| `200` | All files were written successfully |
| `207` | Mixed results — at least one file succeeded, was skipped, or failed |
| `400` | Invalid or missing request fields |
| `413` | One or more files exceed the 10 MB limit |
| `422` | Every file was rejected (e.g. all had unsupported extensions) |

**Response shape**

```json
{
  "repository": "owner/repo",
  "branch": "main",
  "destinationPath": "docs/images",
  "results": [
    {
      "filename": "logo.png",
      "path": "docs/images/logo.png",
      "size": 4096,
      "status": "created",
      "sha": "a1b2c3d4..."
    }
  ]
}
```

Each result entry has a `status` of `created`, `updated`, `skipped`, `rejected`, or `failed`. Entries with errors include an `error` code and a human-readable `message`.

**Example — upload a PNG image**

```bash
curl -X POST https://api.jimmothy.site/api/assets \
  -H "X-API-Key: $GATEWAY_API_KEY" \
  -F "repository=owner/my-project" \
  -F "destinationPath=assets/images" \
  -F "assets=@./logo.png"
```

**Example — upload a WASM binary with a custom branch and commit message**

```bash
curl -X POST https://api.jimmothy.site/api/assets \
  -H "X-API-Key: $GATEWAY_API_KEY" \
  -F "repository=owner/my-project" \
  -F "destinationPath=dist" \
  -F "branch=release/v2" \
  -F "commitMessage=chore: add compiled WASM module" \
  -F "overwrite=true" \
  -F "assets=@./engine.wasm"
```

**Example — upload multiple assets in one request**

```bash
curl -X POST https://api.jimmothy.site/api/assets \
  -H "Authorization: Bearer $GATEWAY_API_KEY" \
  -F "repository=owner/my-project" \
  -F "destinationPath=docs/assets" \
  -F "assets=@./diagram.png" \
  -F "assets=@./data.csv" \
  -F "assets=@./report.pdf"
```

**Supported file types**

Images (`.apng`, `.avif`, `.bmp`, `.gif`, `.ico`, `.jpeg`, `.jpg`, `.png`, `.svg`, `.tiff`, `.webp`), fonts (`.eot`, `.otf`, `.ttf`, `.woff`, `.woff2`), documents/data (`.csv`, `.json`, `.md`, `.pdf`, `.txt`, `.xml`, `.yaml`, `.yml`), web (`.css`, `.htm`, `.html`, `.js`, `.map`, `.ts`), audio/video (`.aac`, `.flac`, `.m4a`, `.mp3`, `.mp4`, `.ogg`, `.wav`, `.webm`), and archives/binaries (`.gz`, `.tar`, `.wasm`, `.zip`). Maximum file size is **10 MB** per file.

---

### Workflows

CRUD and lifecycle management for scheduled workflow definitions. Workflow state is persisted to `data/workflows.json`.

#### `GET /api/workflows`

Returns all workflow definitions.

#### `GET /api/workflows/:id`

Returns a single workflow by ID.

#### `POST /api/workflows`

Creates a new workflow.

```json
{
  "name": "deploy-staging",
  "schedule": "0 */6 * * *",
  "target": { "type": "shell", "ref": "/usr/local/bin/deploy.sh" },
  "enabled": true,
  "input": { "env": "staging" },
  "secrets": ["DEPLOY_KEY"],
  "timeoutSeconds": 300,
  "retryPolicy": { "maxAttempts": 3, "backoffSeconds": 30 }
}
```

Required fields: `name`, `schedule`, `target` (with `type` and `ref`).

#### `PUT /api/workflows/:id`

Partial or full update of a workflow. Accepts any subset of the create payload fields.

#### `DELETE /api/workflows/:id`

Deletes a workflow. Returns `204 No Content`.

#### `POST /api/workflows/:id/enable`

Sets `enabled: true`.

#### `POST /api/workflows/:id/disable`

Sets `enabled: false`.

#### `POST /api/workflows/:id/sleep`

Puts the workflow to sleep until a future timestamp.

```json
{ "until": "2026-04-01T00:00:00Z" }
```

#### `POST /api/workflows/:id/resume`

Clears `sleepUntil` and resets status from `sleeping` to `idle`.

#### `POST /api/workflows/:id/run`

Triggers execution of an enabled workflow. Returns execution metadata. Rejects if the workflow is disabled or already running.

#### `POST /internal/workflows/:id/execute`

Internal execution hook for the control-plane scheduler. Same execution path as `/run` but without the enabled check.

**Execution result shape:**

```json
{
  "workflowId": "uuid",
  "status": "success",
  "startedAt": "2026-03-22T...",
  "completedAt": "2026-03-22T..."
}
```

**Workflow model:**

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Auto-generated UUID |
| `name` | `string` | Human-readable name |
| `enabled` | `boolean` | Whether the workflow is active |
| `schedule` | `string` | Cron expression |
| `sleepUntil` | `string \| null` | ISO timestamp; workflow is paused until this time |
| `target` | `{ type, ref }` | Execution target reference |
| `input` | `object` | Optional key-value input passed to execution |
| `secrets` | `string[]` | Optional secret name references |
| `timeoutSeconds` | `number` | Optional execution timeout |
| `retryPolicy` | `object` | Optional `{ maxAttempts, backoffSeconds }` |
| `lastRunAt` | `string \| null` | Timestamp of last execution |
| `lastStatus` | `string` | `idle`, `running`, `success`, `failed`, or `sleeping` |
| `lastError` | `string \| null` | Error message from last failed run |
| `createdAt` | `string` | Creation timestamp |
| `updatedAt` | `string` | Last modification timestamp |

**Supported target types:**

| Target Type | Status | Description |
|---|---|---|
| `gateway-chat-platform.agent-turn` | Supported | Calls the chat platform `/api/chat` endpoint |
| `legacy.openclaw.imap-triage` | Unsupported | Fails with structured error |
| `legacy.openclaw.tts-mode` | Unsupported | Fails with structured error |

For `gateway-chat-platform.agent-turn`, the workflow `input` must include:
- `prompt` (string, required) — the message sent to the agent
- `threadId` (string, optional) — for thread continuity

The `target.ref` is used as the `agentId`.

---

### Scheduler

An in-process scheduler automatically evaluates enabled workflows on a configurable interval. It:
- Evaluates cron schedule strings against the current time
- Skips disabled, sleeping, and already-running workflows
- Prevents double-runs within the same cron due window
- Logs execution failures to the console

The scheduler starts automatically with the server unless `WORKFLOW_SCHEDULER_ENABLED=false`.

## Testing

```bash
npm test
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Server listen port |
| `GATEWAY_API_KEY` | unset | Optional API key for `/plans-to-project/*` endpoints; accepted via `X-API-Key` or `Authorization: Bearer` |
| `GHP_BINARY` | `ghp` | Path to gh-project-helper binary |
| `GHP_HOST_BIN_DIR` | `/home/jimmothy/.local/bin` | Host directory mounted into the container for a runner-managed `ghp` override |
| `CHAT_PLATFORM_API_BASE_URL` | `http://localhost:3000` | Base URL for the chat platform API |
| `WORKFLOW_SCHEDULER_ENABLED` | `true` | Enable/disable the in-process workflow scheduler |
| `WORKFLOW_SCHEDULER_INTERVAL_MS` | `30000` | Scheduler polling interval in milliseconds |
