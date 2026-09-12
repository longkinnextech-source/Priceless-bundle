"use client";

/** Browser-side API helper: always JSON, always a usable error message. */

export class ApiClientError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;
  constructor(message: string, code: string, status: number, details?: unknown) {
    super(message);
    this.name = "ApiClientError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
      cache: "no-store",
      credentials: "same-origin",
    });
  } catch {
    throw new ApiClientError("Network error. Check your connection and try again.", "NETWORK", 0);
  }

  const text = await response.text();
  let payload: any = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (!response.ok || payload?.ok === false) {
    throw new ApiClientError(
      payload?.message ?? `Request failed (${response.status})`,
      payload?.error ?? "ERROR",
      response.status,
      payload?.details
    );
  }
  return payload as T;
}

export function apiGet<T = any>(path: string): Promise<T> {
  return request<T>(path, { method: "GET" });
}

export function apiPost<T = any>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
}

export function apiPatch<T = any>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, { method: "PATCH", body: body === undefined ? undefined : JSON.stringify(body) });
}
