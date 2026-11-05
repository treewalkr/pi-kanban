import { treaty } from "@elysiajs/eden";
import type { App } from "../../src/app";

// Dev: page on :5174, api on :4600 (CORS enabled). Prod: served same-origin by the api.
export const api = treaty<App>(import.meta.env.DEV ? "http://localhost:4600" : window.location.origin);

// SSE change stream; EventSource is a browser streaming client, not a REST call
export const eventsUrl = import.meta.env.DEV ? "http://localhost:4600/events" : "/events";

// Card-chat SSE stream — same non-Treaty exception as eventsUrl (EventSource, not fetch).
// The handle is encoded: board handles carry free-form project names (`board:a/b c`).
export const chatEventsUrl = (cardId: string) =>
  import.meta.env.DEV
    ? `http://localhost:4600/chat/${chatPathParam(cardId)}/events`
    : `/chat/${chatPathParam(cardId)}/events`;

/**
 * Encode a chat handle for a URL path segment. The ':' scope separator stays raw
 * (path-safe, keeps `/chat/board:<p>` readable in logs/devtools); everything else
 * is percent-encoded, so project names with '/', '?', '#', '%' or spaces survive.
 */
export const chatPathParam = (cardId: string): string => cardId.split(":").map(encodeURIComponent).join(":");

// Raw file stream/download URL for resource tags (img src, anchor href)
export const rawFilesUrl = import.meta.env.DEV ? "http://localhost:4600/files/raw" : "/files/raw";

export function rawFileUrl(path: string, download = false): string {
  const query = download
    ? `path=${encodeURIComponent(path)}&download=1`
    : `path=${encodeURIComponent(path)}`;
  return `${rawFilesUrl}?${query}`;
}

