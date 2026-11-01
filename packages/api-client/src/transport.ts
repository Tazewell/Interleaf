import { diagnosticFetch } from "./diagnostics";
export let sessionToken = "";
export function configureAPI(token: string) {
  sessionToken = token;
}
/** A failed request; `code` and `pages` identify a long paper to confirm. */
export class RequestError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly pages?: number,
    readonly status?: number,
  ) {
    super(message);
  }
}
export async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await requestResponse(path, init);
  return response.status === 204 ? (undefined as T) : response.json();
}

/** Authenticated raw transport for SSE and inert text exports. */
export async function requestResponse(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const response = await diagnosticFetch(path, {
    ...init,
    headers: {
      Authorization: `Bearer ${sessionToken}`,
      ...(init.body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
      ...init.headers,
    },
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new RequestError(
      data.error || `请求失败 (${response.status})`,
      data.code,
      data.pages,
      response.status,
    );
  }
  return response;
}
