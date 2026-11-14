interface OpsWorkerEnv {
  EDGE_ORIGIN: string;
  EDGE?: { fetch(request: Request): Promise<Response> };
  ASSETS: { fetch(request: Request): Promise<Response> };
}

/** Serve the dedicated UI and proxy Better Auth/API calls onto one origin. */
export default {
  async fetch(request: Request, env: OpsWorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/ops/")) return env.ASSETS.fetch(request);

    const target = new URL(url.pathname + url.search, env.EDGE_ORIGIN);
    const headers = new Headers(request.headers);
    headers.set("host", target.host);
    headers.set("origin", env.EDGE_ORIGIN);
    const upstream = new Request(target.toString(), new Request(request, { headers }));
    const response = await (env.EDGE ? env.EDGE.fetch(upstream) : fetch(upstream));
    const location = response.headers.get("location");
    if (!location) return response;

    // Better Auth builds redirects from the edge base URL. Keep browser
    // navigation on the dedicated dashboard origin after magic-link verification.
    const redirect = new URL(location, env.EDGE_ORIGIN);
    if (redirect.origin !== new URL(env.EDGE_ORIGIN).origin) return response;
    const publicRedirect = new URL(redirect.pathname + redirect.search + redirect.hash, url.origin);
    const responseHeaders = new Headers(response.headers);
    responseHeaders.set("location", publicRedirect.toString());
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: responseHeaders });
  },
};
