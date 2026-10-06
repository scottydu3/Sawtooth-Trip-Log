import { getToken } from "./auth";

const BASE = "https://graph.microsoft.com/v1.0";

export class GraphError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
  }
}

export interface GraphResponse<T> {
  status: number;
  data: T;
  etag: string | null;
}

export async function graph<T = unknown>(
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string>; raw?: boolean; scopes?: string[] } = {},
): Promise<GraphResponse<T>> {
  const token = await getToken(init.scopes);
  const headers: Record<string, string> = {
    Authorization: "Bearer " + token,
    Prefer: 'outlook.timezone="UTC"',
    ...init.headers,
  };
  let body: BodyInit | undefined;
  if (init.body !== undefined) {
    if (init.raw) body = init.body as BodyInit;
    else {
      body = JSON.stringify(init.body);
      headers["Content-Type"] ??= "application/json";
    }
  }
  const res = await fetch(BASE + path, { method: init.method || "GET", headers, body });
  const text = await res.text();
  let data: unknown = text;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
  if (!res.ok) {
    const msg = (data as { error?: { message?: string } })?.error?.message || res.statusText;
    throw new GraphError(res.status, msg, data);
  }
  return { status: res.status, data: data as T, etag: res.headers.get("ETag") };
}
