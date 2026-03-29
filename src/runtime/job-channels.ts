import { readFile } from "node:fs/promises";
import path from "node:path";

export interface JobChannelConfig {
  id: string;
  type: "telegram" | "webhook";
  enabled: boolean;
  description?: string;
  botToken?: string;
  chatId?: string;
  parseMode?: string;
  messageThreadId?: number;
  webhookUrl?: string;
}

interface JobChannelFile {
  channels: JobChannelConfig[];
}

export interface DeliveryRequest {
  channelId: string;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface DeliveryResult {
  channelId: string;
  type: JobChannelConfig["type"];
  status: number;
}

function getChannelsPath(): string {
  return process.env.GATEWAY_JOB_CHANNELS_PATH?.trim() || path.join(process.cwd(), "data", "job-channels.json");
}

async function loadChannelFile(): Promise<JobChannelFile> {
  const filePath = getChannelsPath();
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as JobChannelFile).channels)) {
      throw new Error(`Invalid job channel config at ${filePath}`);
    }
    return parsed as JobChannelFile;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return { channels: [] };
    }
    throw new Error(`Failed to load job channels: ${message}`);
  }
}

async function sendTelegramMessage(channel: JobChannelConfig, text: string): Promise<number> {
  if (!channel.botToken || !channel.chatId) {
    throw new Error(`Telegram channel ${channel.id} requires botToken and chatId`);
  }

  const response = await fetch(`https://api.telegram.org/bot${channel.botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: channel.chatId,
      text,
      ...(channel.parseMode ? { parse_mode: channel.parseMode } : {}),
      ...(channel.messageThreadId ? { message_thread_id: channel.messageThreadId } : {}),
    }),
  });

  const payload = await response.text().catch(() => "");
  if (!response.ok) {
    throw new Error(`Telegram delivery failed (${response.status}): ${payload.slice(0, 500)}`);
  }
  return response.status;
}

async function sendWebhookMessage(
  channel: JobChannelConfig,
  text: string,
  metadata?: Record<string, unknown>
): Promise<number> {
  if (!channel.webhookUrl) {
    throw new Error(`Webhook channel ${channel.id} requires webhookUrl`);
  }

  const response = await fetch(channel.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, metadata }),
  });
  const payload = await response.text().catch(() => "");
  if (!response.ok) {
    throw new Error(`Webhook delivery failed (${response.status}): ${payload.slice(0, 500)}`);
  }
  return response.status;
}

export async function deliverToChannel(request: DeliveryRequest): Promise<DeliveryResult> {
  const config = await loadChannelFile();
  const channel = config.channels.find((candidate) => candidate.id === request.channelId);
  if (!channel) {
    throw new Error(`Unknown delivery channel: ${request.channelId}`);
  }
  if (!channel.enabled) {
    throw new Error(`Delivery channel is disabled: ${request.channelId}`);
  }

  const status = channel.type === "telegram"
    ? await sendTelegramMessage(channel, request.text)
    : await sendWebhookMessage(channel, request.text, request.metadata);

  return {
    channelId: channel.id,
    type: channel.type,
    status,
  };
}
