import { headers } from "next/headers";

/**
 * Absolute base URL for the current deployment, used for webhook registration
 * (Telegram setWebhook, WhatsApp callbacks) and for the copy-paste webhook
 * address in the admin panel.
 *
 * PUBLIC_BASE_URL always wins, so a deployment can pin its canonical domain.
 * Otherwise it falls back to localhost — use `requestBaseUrl()` inside a
 * request handler when the deployment sits behind a proxy.
 */
export function absoluteUrl(path = ""): string {
  const configured = process.env.PUBLIC_BASE_URL ?? process.env.NEXT_PUBLIC_BASE_URL;
  const normalisedPath = path.startsWith("/") ? path : path ? `/${path}` : "";
  if (configured) return `${configured.replace(/\/$/, "")}${normalisedPath}`;
  return `http://localhost:${process.env.PORT ?? 3000}${normalisedPath}`;
}

const LOCAL_HOST = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

/**
 * Same, but derived from the incoming request when available.
 *
 * A *localhost* PUBLIC_BASE_URL is treated as an unset placeholder: it is what
 * you get from a dev default, and it is never the address a phone or a bot can
 * reach. In that case the forwarded host wins, so previews and tunnels show the
 * address that actually works. A real domain in PUBLIC_BASE_URL always wins.
 */
export async function requestBaseUrl(): Promise<string> {
  const configured = (process.env.PUBLIC_BASE_URL ?? process.env.NEXT_PUBLIC_BASE_URL)?.replace(/\/$/, "");
  if (configured && !LOCAL_HOST.test(configured)) return configured;
  try {
    const h = await headers();
    const host = h.get("x-forwarded-host") ?? h.get("host");
    const proto = h.get("x-forwarded-proto") ?? (host?.startsWith("localhost") ? "http" : "https");
    if (host) return `${proto}://${host}`;
  } catch {
    /* headers() is unavailable outside a request scope */
  }
  return configured ?? `http://localhost:${process.env.PORT ?? 3000}`;
}
