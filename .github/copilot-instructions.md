# Copilot Instructions For gateway-api

## Control-plane ownership

This repo does **not** own its production deployment topology. The source of truth for runtime wiring is the `gateway-control-plane` repo and the live `gateway.config.json` used on the gateway host.

When making changes here, assume the following are controlled externally by `gateway-control-plane`:

- public route mounting under `/api/`
- blue/green slot selection and promotion
- slot host ports and upstream switching
- generated nginx config on the gateway host
- deploy roots, env file paths, and start/stop commands
- GitHub Actions deploy execution on the self-hosted gateway runner

Do not silently hardcode or rename any of those without coordinating a matching control-plane change.

## Current production shape

The app is deployed as a blue/green Docker service behind the gateway host nginx.

Important operational assumptions:

- The app's container health endpoint is `/health`.
- Public traffic is routed through the gateway host under `/api/...`.
- Direct host slot ports are for blue/green health checks and debugging only.
- Production deploys are triggered by `gateway-control-plane/deploy/bin/deploy-app.sh` using a specific git SHA.

## Changes that require a control-plane follow-up

If you change any of the following, update `gateway-control-plane` config/docs in the same change set or note it explicitly in the PR:

- route paths or URL structure
- health or readiness endpoint behavior
- required environment variables or env file format
- docker-compose contract or container startup command
- workflow endpoint paths, request payloads, or response shapes
- scheduler execution hooks
- port expectations
- hostname assumptions

## Workflow API contract

`gateway-control-plane` proxies workflow management through this repo. Keep these endpoints stable unless the control-plane is updated in lockstep:

- `GET /api/workflows`
- `GET /api/workflows/:id`
- `POST /api/workflows`
- `PUT /api/workflows/:id`
- `DELETE /api/workflows/:id`
- `POST /api/workflows/:id/enable`
- `POST /api/workflows/:id/disable`
- `POST /api/workflows/:id/sleep`
- `POST /api/workflows/:id/resume`
- `POST /api/workflows/:id/run`
- `POST /internal/workflows/:id/execute`

Avoid breaking these without coordinating the admin UI and service profile logic in `gateway-control-plane`.

## Development guidance

Prefer changes that keep local development simple while preserving the production control-plane contract.

If you introduce a new operational requirement, document:

- what changed
- whether `gateway-control-plane` config must change
- whether the gateway deploy runner or nginx generation must change
