import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

type QueryValue = string | number | boolean | null | undefined;

interface RequestOptions {
  query?: Record<string, QueryValue>;
  body?: unknown;
}

export class StorytimeConfigError extends Error {
  constructor() {
    super("STORYTIME_BASE_URL is not configured");
    this.name = "StorytimeConfigError";
  }
}

export class StorytimeUpstreamError extends Error {
  statusCode: number;
  details: unknown;

  constructor(statusCode: number, message: string, details?: unknown) {
    super(message);
    this.name = "StorytimeUpstreamError";
    this.statusCode = statusCode;
    this.details = details;
  }
}

export class StorytimeClient {
  private readonly baseUrl?: string;
  private readonly timeoutMs: number;
  private readonly hostHeader?: string;

  constructor(
    baseUrl = process.env.STORYTIME_BASE_URL,
    timeoutMs = parseInt(process.env.STORYTIME_TIMEOUT_MS ?? "15000", 10),
    hostHeader = process.env.STORYTIME_HOST_HEADER,
  ) {
    const trimmed = baseUrl?.trim();
    this.baseUrl = trimmed ? trimmed.replace(/\/+$/, "") : undefined;
    this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 15000;
    this.hostHeader = hostHeader?.trim() || undefined;
  }

  async get<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>("GET", path, options);
  }

  async getText(path: string, options: RequestOptions = {}): Promise<{ text: string; contentType?: string }> {
    return this.requestText("GET", path, options);
  }

  async post<T>(path: string, body?: unknown, options: Omit<RequestOptions, "body"> = {}): Promise<T> {
    return this.request<T>("POST", path, { ...options, body });
  }

  async patch<T>(path: string, body?: unknown, options: Omit<RequestOptions, "body"> = {}): Promise<T> {
    return this.request<T>("PATCH", path, { ...options, body });
  }

  async put<T>(path: string, body?: unknown, options: Omit<RequestOptions, "body"> = {}): Promise<T> {
    return this.request<T>("PUT", path, { ...options, body });
  }

  private buildUrl(path: string, query: Record<string, QueryValue> = {}): URL {
    if (!this.baseUrl) {
      throw new StorytimeConfigError();
    }

    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const url = new URL(`${this.baseUrl}${normalizedPath}`);
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") {
        continue;
      }
      url.searchParams.set(key, String(value));
    }
    return url;
  }

  private async request<T>(method: string, path: string, options: RequestOptions): Promise<T> {
    const url = this.buildUrl(path, options.query);

    try {
      const response = this.hostHeader
        ? await this.nodeRequest(method, url, options)
        : await this.fetchRequest(method, url, options);
      const { status, text } = response;
      const parsed = parseJson(text);

      if (status < 200 || status >= 300) {
        throw new StorytimeUpstreamError(
          status,
          extractErrorMessage(parsed) ?? `StoryTime request failed with HTTP ${status}`,
          parsed,
        );
      }

      return parsed as T;
    } catch (err) {
      if (err instanceof StorytimeUpstreamError || err instanceof StorytimeConfigError) {
        throw err;
      }
      const message = err instanceof Error && err.name === "AbortError"
        ? `StoryTime request timed out after ${this.timeoutMs}ms`
        : err instanceof Error
          ? err.message
          : "StoryTime request failed";
      throw new StorytimeUpstreamError(502, message);
    }
  }

  private async requestText(method: string, path: string, options: RequestOptions): Promise<{ text: string; contentType?: string }> {
    const url = this.buildUrl(path, options.query);

    try {
      const response = this.hostHeader
        ? await this.nodeRequest(method, url, options)
        : await this.fetchRequest(method, url, options);
      const { status, text, contentType } = response;

      if (status < 200 || status >= 300) {
        const parsed = parseJson(text);
        throw new StorytimeUpstreamError(
          status,
          extractErrorMessage(parsed) ?? `StoryTime request failed with HTTP ${status}`,
          parsed,
        );
      }

      return {
        text,
        contentType,
      };
    } catch (err) {
      if (err instanceof StorytimeUpstreamError || err instanceof StorytimeConfigError) {
        throw err;
      }
      const message = err instanceof Error && err.name === "AbortError"
        ? `StoryTime request timed out after ${this.timeoutMs}ms`
        : err instanceof Error
          ? err.message
          : "StoryTime request failed";
      throw new StorytimeUpstreamError(502, message);
    }
  }

  private async fetchRequest(method: string, url: URL, options: RequestOptions): Promise<{ status: number; text: string; contentType?: string }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref?.();

    try {
      const response = await fetch(url, {
        method,
        headers: options.body === undefined ? undefined : { "content-type": "application/json" },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
      return {
        status: response.status,
        text: await response.text(),
        contentType: response.headers.get("content-type") ?? undefined,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async nodeRequest(method: string, url: URL, options: RequestOptions): Promise<{ status: number; text: string; contentType?: string }> {
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const headers: Record<string, string | number> = {
      host: this.hostHeader!,
    };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      headers["content-length"] = Buffer.byteLength(body);
    }

    return new Promise((resolve, reject) => {
      const request = (url.protocol === "https:" ? httpsRequest : httpRequest)({
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method,
        headers,
        timeout: this.timeoutMs,
      }, (response) => {
        response.setEncoding("utf8");
        let text = "";
        response.on("data", (chunk: string) => {
          text += chunk;
        });
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            text,
            contentType: response.headers["content-type"],
          });
        });
      });

      request.on("timeout", () => {
        request.destroy(new Error(`StoryTime request timed out after ${this.timeoutMs}ms`));
      });
      request.on("error", reject);
      if (body !== undefined) {
        request.write(body);
      }
      request.end();
    });
  }
}

function parseJson(text: string): unknown {
  if (!text.trim()) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

function extractErrorMessage(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const error = (value as { error?: unknown }).error;
  return typeof error === "string" && error.trim() ? error.trim() : undefined;
}
