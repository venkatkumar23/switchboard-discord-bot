export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body: Record<string, unknown> | null = null,
  ) {
    super(message);
  }
}

const FALLBACK_MESSAGES: Record<number, string> = {
  400: "That request wasn't valid.",
  401: "Your session has ended. Please sign in again.",
  403: "That action isn't allowed.",
  404: "Not found.",
  429: "Too many attempts. Please wait a moment.",
  502: "Discord didn't answer. Try again in a moment.",
};

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith("/api/auth/login")) {
      window.dispatchEvent(new Event("sb:unauthorized"));
    }
    const message = typeof data?.message === "string" ? data.message : (FALLBACK_MESSAGES[res.status] ?? `Request failed (${res.status})`);
    throw new ApiError(res.status, typeof data?.error === "string" ? data.error : "error", message, data);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}),
  put: <T>(path: string, body: unknown) => request<T>("PUT", path, body),
  patch: <T>(path: string, body: unknown) => request<T>("PATCH", path, body),
  del: <T>(path: string) => request<T>("DELETE", path),
};

export const guildPath = (guildId: string, path = "") => `/api/guilds/${guildId}${path}`;
