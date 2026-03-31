import { exec as execCallback } from "node:child_process";
import { promisify } from "node:util";
import type { Workflow } from "../types/workflow.js";
import { loadJobModule, type JobMetadata } from "./job-catalog.js";
import { deliverToChannel, type DeliveryResult } from "./job-channels.js";

const exec = promisify(execCallback);

const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com";
const OPENAI_DEFAULT_MODEL = process.env.OPENAI_DEFAULT_MODEL?.trim() || "";
const CHAT_PLATFORM_BASE_URL = process.env.CHAT_PLATFORM_API_BASE_URL?.trim() || "http://localhost:3000";

export interface ShellResult {
  stdout: string;
  stderr: string;
  command: string;
  cwd?: string;
}

export interface AgentRunResult {
  agentId: string;
  usedProvider: string;
  model: string;
  content: string;
  latencyMs: number;
  inbox?: {
    messageId: string;
    userId: string;
    channelId: string;
  };
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface OpenAiRunOptions {
  model?: string;
  prompt: string;
  system?: string;
}

export interface JobExecutionContext {
  workflow: Workflow;
  input: Record<string, unknown>;
  job: JobMetadata;
  log: (message: string) => void;
  callOpenAi: (options: OpenAiRunOptions) => Promise<string>;
  runShell: (command: string, cwd?: string) => Promise<ShellResult>;
  runAgent: (
    agentId: string,
    prompt: string,
    delivery?: Record<string, unknown>,
    context?: Record<string, unknown>
  ) => Promise<AgentRunResult>;
  deliver: (channelId: string, text: string, metadata?: Record<string, unknown>) => Promise<DeliveryResult>;
}

function extractAssistantContent(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    throw new Error("OpenAI response was not an object");
  }

  const record = payload as Record<string, unknown>;
  if (typeof record.output_text === "string" && record.output_text.trim()) {
    return record.output_text;
  }

  const choices = record.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const firstChoice = choices[0] as Record<string, unknown>;
    const message = firstChoice.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (typeof content === "string" && content.trim()) {
      return content;
    }
    if (Array.isArray(content)) {
      const textParts = content
        .map((item) => {
          if (!item || typeof item !== "object") return "";
          const part = item as Record<string, unknown>;
          if (typeof part.text === "string") return part.text;
          return "";
        })
        .filter(Boolean);
      if (textParts.length > 0) {
        return textParts.join("\n");
      }
    }
  }

  throw new Error("Could not extract text from OpenAI response");
}

async function callOpenAi(options: OpenAiRunOptions): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured");
  }

  const model = options.model?.trim() || OPENAI_DEFAULT_MODEL;
  if (!model) {
    throw new Error("OpenAI model is required");
  }

  const response = await fetch(`${OPENAI_BASE_URL.replace(/\/$/, "")}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        ...(options.system ? [{ role: "system", content: options.system }] : []),
        { role: "user", content: options.prompt },
      ],
    }),
  });

  const bodyText = await response.text().catch(() => "");
  if (!response.ok) {
    throw new Error(`OpenAI request failed (${response.status}): ${bodyText.slice(0, 500)}`);
  }

  const payload = bodyText ? JSON.parse(bodyText) as unknown : {};
  return extractAssistantContent(payload);
}

async function runShell(command: string, cwd?: string): Promise<ShellResult> {
  try {
    const result = await exec(command, {
      cwd,
      maxBuffer: 1024 * 1024 * 2,
    });
    return {
      command,
      cwd,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stdout = typeof (error as { stdout?: unknown }).stdout === "string" ? (error as { stdout: string }).stdout : "";
    const stderr = typeof (error as { stderr?: unknown }).stderr === "string" ? (error as { stderr: string }).stderr : "";
    throw new Error(`Shell command failed: ${message}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
  }
}

async function runAgent(
  agentId: string,
  prompt: string,
  delivery?: Record<string, unknown>,
  context?: Record<string, unknown>
): Promise<AgentRunResult> {
  const response = await fetch(
    `${CHAT_PLATFORM_BASE_URL.replace(/\/$/, "")}/api/agents/${encodeURIComponent(agentId)}/run`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt,
        ...(context ? { context } : {}),
        ...(delivery ? { delivery } : {}),
      }),
    }
  );

  const bodyText = await response.text().catch(() => "");
  if (!response.ok) {
    throw new Error(`Chat platform agent run failed (${response.status}): ${bodyText.slice(0, 500)}`);
  }
  return JSON.parse(bodyText) as AgentRunResult;
}

export async function executeCatalogJob(workflow: Workflow): Promise<unknown> {
  const jobModule = await loadJobModule(workflow.target.ref);
  const input = workflow.input ?? {};
  const logPrefix = `[job:${jobModule.meta.id} workflow:${workflow.id}]`;

  const context: JobExecutionContext = {
    workflow,
    input,
    job: jobModule.meta,
    log: (message) => console.log(`${logPrefix} ${message}`),
    callOpenAi,
    runShell,
    runAgent,
    deliver: (channelId, text, metadata) => deliverToChannel({ channelId, text, metadata }),
  };

  return jobModule.run(context);
}
