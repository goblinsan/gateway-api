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

## Endpoints

### `GET /health`

Returns `{ "status": "ok" }`.

### `POST /plans-to-project/validate`

Validates a plan YAML file against the `ghp` schema.

- **Body**: `multipart/form-data` with a `plan` field containing a `.yaml`/`.yml` file
- **200**: `{ "valid": true, "output": "..." }`
- **422**: `{ "valid": false, "error": "..." }`

### `POST /plans-to-project/apply`

Applies a plan YAML file to create GitHub project milestones, epics, and issues.

- **Body**: `multipart/form-data` with a `plan` field containing a `.yaml`/`.yml` file
- **Query**: `?dryRun=true` to preview without applying
- **200**: `{ "success": true, "output": "...", "warnings": "..." }`
- **500**: `{ "success": false, "error": "..." }`

Requires `ghp` binary on `PATH` (or set `GHP_BINARY` env var). GitHub auth is handled by `ghp` via `GITHUB_TOKEN` env var or `~/.gh-project-helper.yaml`.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Server listen port |
| `GHP_BINARY` | `ghp` | Path to gh-project-helper binary |
