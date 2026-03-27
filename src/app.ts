import crypto from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { plansToProjectRouter } from "./routes/plans-to-project.js";
import { createWorkflowRouter } from "./routes/workflows.js";
import { createInternalWorkflowRouter } from "./routes/internal-workflows.js";
import { WorkflowStore } from "./store/workflow-store.js";

function getConfiguredGatewayApiKey(): string | undefined {
  const value = process.env.GATEWAY_API_KEY?.trim();
  return value ? value : undefined;
}

function getPresentedApiKey(req: Request): string | undefined {
  const xApiKey = req.header("x-api-key")?.trim();
  if (xApiKey) {
    return xApiKey;
  }

  const authorization = req.header("authorization")?.trim();
  if (!authorization) {
    return undefined;
  }

  const [scheme, token] = authorization.split(/\s+/, 2);
  if (!scheme || !token || scheme.toLowerCase() !== "bearer") {
    return undefined;
  }

  return token.trim() || undefined;
}

function apiKeysMatch(expected: string, presented: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const presentedBuffer = Buffer.from(presented);
  if (expectedBuffer.length !== presentedBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuffer, presentedBuffer);
}

function requireGatewayApiKey(req: Request, res: Response, next: NextFunction): void {
  const configuredKey = getConfiguredGatewayApiKey();
  if (!configuredKey) {
    next();
    return;
  }

  const presentedKey = getPresentedApiKey(req);
  if (!presentedKey) {
    res.status(401).json({ error: "Missing API key" });
    return;
  }

  if (!apiKeysMatch(configuredKey, presentedKey)) {
    res.status(403).json({ error: "Invalid API key" });
    return;
  }

  next();
}

function renderPrivacyPolicyHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Gateway API Privacy Policy</title>
    <style>
      :root {
        color-scheme: light;
        font-family: Georgia, "Times New Roman", serif;
        --bg: #f5f2ea;
        --panel: #fffdf8;
        --ink: #18322d;
        --muted: #4d625b;
        --line: #d8ddd8;
      }
      body {
        margin: 0;
        background: linear-gradient(180deg, #edf2ef 0%, var(--bg) 100%);
        color: var(--ink);
      }
      main {
        max-width: 860px;
        margin: 48px auto;
        padding: 40px;
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 24px;
        box-shadow: 0 20px 60px rgba(24, 50, 45, 0.08);
      }
      h1, h2 {
        font-family: "Helvetica Neue", Arial, sans-serif;
        color: #123d35;
      }
      p, li {
        line-height: 1.7;
        color: var(--muted);
      }
      code {
        background: #eef2ef;
        padding: 0.1rem 0.35rem;
        border-radius: 6px;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Privacy Policy</h1>
      <p>Last updated: March 26, 2026</p>

      <p>
        This service is operated by Jimmothy for personal workflow automation and GitHub project planning.
        It is intended for a limited set of authorized users and integrations.
      </p>

      <h2>What Data This Service Receives</h2>
      <ul>
        <li>YAML planning content submitted to the <code>/plans-to-project</code> endpoints.</li>
        <li>Repository names, project titles, milestone names, epic titles, issue titles, labels, and assignees contained in that submitted plan.</li>
        <li>Standard request metadata such as timestamps, IP address, and user agent that may appear in normal server and reverse-proxy logs.</li>
      </ul>

      <h2>How Data Is Used</h2>
      <ul>
        <li>To validate project plans and create or update GitHub projects, repositories, milestones, epics, and issues when explicitly requested.</li>
        <li>To resolve repository matches during preflight and to support authenticated automation workflows.</li>
        <li>To operate, secure, debug, and improve the service.</li>
      </ul>

      <h2>How Data Is Shared</h2>
      <p>
        Submitted planning data may be sent to GitHub through the configured helper tool in order to create or update GitHub resources.
        Requests may also transit Cloudflare because this service is exposed through Cloudflare Tunnel and related Cloudflare security products.
        Data is not sold.
      </p>

      <h2>Retention</h2>
      <p>
        Planning requests may be retained in transient application logs, reverse-proxy logs, workflow records, and GitHub-side artifacts created from the request.
        Temporary files used to process plan submissions are deleted after request handling, but operational logs may persist for debugging and audit purposes.
      </p>

      <h2>Security</h2>
      <p>
        Sensitive endpoints are protected with API-key authentication and infrastructure access controls where configured. No method of storage or transmission is guaranteed to be perfectly secure.
      </p>

      <h2>Your Choices</h2>
      <p>
        Do not submit sensitive personal data, secrets, or regulated information through this service. If you need information removed from locally retained logs under your control, contact the operator directly.
      </p>

      <h2>Contact</h2>
      <p>
        For questions about this policy, contact the operator of <code>api.jimmothy.site</code> through the same channel used to access the service.
      </p>
    </main>
  </body>
</html>`;
}

export function createApp(store?: WorkflowStore) {
  const app = express();
  const workflowStore = store ?? new WorkflowStore();

  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/policy", (_req, res) => {
    res.type("html").send(renderPrivacyPolicyHtml());
  });

  app.use("/plans-to-project", requireGatewayApiKey, plansToProjectRouter);
  app.use("/api/workflows", requireGatewayApiKey, createWorkflowRouter(workflowStore));
  app.use("/internal/workflows", createInternalWorkflowRouter(workflowStore));

  return { app, workflowStore };
}
