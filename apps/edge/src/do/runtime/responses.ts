/** JSON and domain-error responses in the wire's error shape. */

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function errorResponse(
  status: number,
  error: string,
  message: string,
  extra?: Record<string, unknown>,
): Response {
  return jsonResponse({ error, message, ...extra }, status);
}

export function notFound(message: string): Response {
  return errorResponse(404, "not-found", message);
}

export function conflict(message: string, extra?: Record<string, unknown>): Response {
  return errorResponse(409, "conflict", message, extra);
}

/** A domain refusal (close gate, lapsed deadline): 409 with a clear reason. */
export function refusal(code: string, message: string): Response {
  return errorResponse(409, code, message, { refusal: message });
}

/** Wrap a DO handler so unexpected failures become 500s, never hangs. */
export async function internalErrorGuard(handler: () => Promise<Response> | Response): Promise<Response> {
  try {
    return await handler();
  } catch (error) {
    return errorResponse(500, "internal-error", error instanceof Error ? error.message : String(error));
  }
}
