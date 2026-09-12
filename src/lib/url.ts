import { headers } from "next/headers";

/**
 * Absolute base URL for the current deployment, used for webhook registration
 * (Telegram setWebhook, WhatsApp callbacks). Prefers PUBLIC_BASE_URL so a
 * deployment behind a proxy registers the right address, then falls back to
 * the forwarded host, then to localhost for development.
 */
export function absoluteUrl(path = ""): string {
  const configured = process.env.PUBLIC_BASE_URL ?? process.env.NEXT_PUBLIC_BASE_URL;
  const normalisedPath = path.startsWith("/") ? path : path ? `/${path}` : "";
  if (configured) return `${configured.replace(/\/$/, "")}${normalisedPath}`;
  return `http://localhost:${process.env.PORT ?? 3000}${normalisedPath}`;
}

/** Same, but derived from the incoming request when available. */
export async function requestBaseUrl(): Promise<string> {
  const configured = process.env.PUBLIC_BASE_URL ?? process.env.NEXT_PUBLIC_BASE_URL;
  if (configured) return configured.replace(/\/$/, "");
  try {
    const h = await headers();
    const host = h.get("x-forwarded-host") ?? h.get("host");
    const proto = h.get("x-forwarded-proto") ?? (host?.startsWith("localhost") ? "http" : "https");
    if (host) return `${proto}://${host}`;
  } catch {
    /* headers() is unavailable outside a request scope */
  }
  return `http://localhost:${process.env.PORT ?? 3000}`;
}
