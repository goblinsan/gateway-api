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

The Dockerfile uses a multi-stage build that compiles the `ghp` binary from source (Go) and bundles it into the final Node.js image. Set `GITHUB_TOKEN` in your `.env` file for `ghp` authentication.

## Endpoints

### `GET /health`

Returns `{ "status": "ok" }`.

### `POST /plans-to-project/validate`

Validates a plan YAML file against the `ghp` schema.

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
| `GHP_BINARY` | `ghp` | Path to gh-project-helper binary |
| `CHAT_PLATFORM_API_BASE_URL` | `http://localhost:3000` | Base URL for the chat platform API |
| `WORKFLOW_SCHEDULER_ENABLED` | `true` | Enable/disable the in-process workflow scheduler |
| `WORKFLOW_SCHEDULER_INTERVAL_MS` | `30000` | Scheduler polling interval in milliseconds |
