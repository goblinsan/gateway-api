import type { Workflow } from "../types/workflow.js";

const CHAT_PLATFORM_BASE_URL =
  process.env.CHAT_PLATFORM_API_BASE_URL ?? "http://localhost:3000";

export interface AgentTurnPayload {
  agentId: string;
  messages: Array<{ role: "user"; content: string }>;
  threadId?: string;
}

export async function executeAgentTurn(workflow: Workflow): Promise<void> {
  const agentId = workflow.target.ref;
  const input = workflow.input ?? {};
  const prompt = input.prompt;

  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    throw new Error("workflow.input.prompt is required for agent-turn targets");
  }

  const payload: AgentTurnPayload = {
    agentId,
    messages: [{ role: "user", content: prompt }],
  };

  if (typeof input.threadId === "string") {
    payload.threadId = input.threadId;
  }

  const url = `${CHAT_PLATFORM_BASE_URL}/api/chat`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(
      (workflow.timeoutSeconds ?? 120) * 1000
    ),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Chat platform returned ${response.status}: ${body.slice(0, 500)}`
    );
  }
}
