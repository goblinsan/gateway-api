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

  constructor(baseUrl = process.env.STORYTIME_BASE_URL, timeoutMs = parseInt(process.env.STORYTIME_TIMEOUT_MS ?? "15000", 10)) {
    const trimmed = baseUrl?.trim();
    this.baseUrl = trimmed ? trimmed.replace(/\/+$/, "") : undefined;
    this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 15000;
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

      const text = await response.text();
      const parsed = parseJson(text);

      if (!response.ok) {
        throw new StorytimeUpstreamError(
          response.status,
          extractErrorMessage(parsed) ?? `StoryTime request failed with HTTP ${response.status}`,
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
    } finally {
      clearTimeout(timeout);
    }
  }

  private async requestText(method: string, path: string, options: RequestOptions): Promise<{ text: string; contentType?: string }> {
    const url = this.buildUrl(path, options.query);
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

      const text = await response.text();

      if (!response.ok) {
        const parsed = parseJson(text);
        throw new StorytimeUpstreamError(
          response.status,
          extractErrorMessage(parsed) ?? `StoryTime request failed with HTTP ${response.status}`,
          parsed,
        );
      }

      return {
        text,
        contentType: response.headers.get("content-type") ?? undefined,
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
    } finally {
      clearTimeout(timeout);
    }
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
