/**
 * @sui/gateway/planes — B5.7, splitting the gateway in two.
 *
 * One process doing everything is the wrong shape for the two jobs it does:
 *
 *   **Model plane**   holds provider credentials, talks to providers, and is the
 *                     only thing that needs egress. Loopback, no public surface.
 *   **Agent plane**   the surface agents talk to: MCP, run bounds, approvals,
 *                     attribution. Holds no provider credentials at all.
 *
 * The point of the split is the credential boundary. If an agent-facing surface
 * is ever exposed, or an MCP client is compromised, it cannot reach a provider
 * key — because it does not have one, and cannot get one. It can only ask the
 * model plane, which knows who it is talking to.
 *
 * The link between them is a service token, checked in constant time, and the
 * model plane refuses anything else — including its own admin surface.
 */

import { timingSafeEqual } from 'node:crypto';

export const PLANE_ROLES = ['both', 'model', 'agent'];

/**
 * Compare two secrets without leaking their length or content through timing.
 *
 * @param {string} presented
 * @param {string} expected
 */
export function tokenMatches(presented, expected) {
  if (typeof presented !== 'string' || typeof expected !== 'string' || !expected) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // still do the comparison, so the timing does not depend on the length
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * What a plane of this role is allowed to serve.
 *
 * @param {string} role
 */
export function planePolicy(role) {
  const isModel = role === 'model';
  const isAgent = role === 'agent';
  return {
    role,
    // the model plane serves the data plane; the agent plane serves the control
    // surface; `both` serves everything, as it did before the split existed
    serves: {
      // the agent plane serves chat too — it forwards it. What it does not have
      // is a provider, which is the point of the split.
      chat: true,
      models: !isAgent,
      status: true,
      metrics: !isAgent,
      runs: !isModel,
      mcp: !isModel,
      tenants: !isModel,
    },
    // only the model plane may hold provider credentials
    holdsProviderCredentials: !isAgent,
    // only the agent plane is meant to be reachable by agents
    agentFacing: !isModel,
  };
}

/**
 * The agent plane's forwarder: it takes a chat request, applies the run bounds
 * it already knows about, and hands the request to the model plane with the
 * service token attached.
 *
 * @param {{modelPlaneUrl: string, serviceToken: string, fetchImpl?: typeof fetch, timeoutMs?: number, logger?: any}} opts
 */
export function createModelPlaneClient(opts) {
  if (!opts?.modelPlaneUrl) throw new Error('The agent plane needs modelPlaneUrl — where is the model plane?');
  if (!opts?.serviceToken) throw new Error('The agent plane needs a service token to reach the model plane.');

  const base = String(opts.modelPlaneUrl).replace(/\/+$/, '');
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = Number(opts.timeoutMs ?? 120_000);

  /**
   * @param {{path: string, method?: string, body?: any, headers?: Record<string, string>}} req
   */
  async function forward(req) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(`${base}${req.path}`, {
        method: req.method ?? 'GET',
        headers: {
          'content-type': 'application/json',
          // the token is the whole point: the model plane serves nobody else
          'x-sui-plane-token': opts.serviceToken,
          ...(req.headers ?? {}),
        },
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
        signal: controller.signal,
      });
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { status: res.status, json, text };
    } catch (err) {
      const message = /** @type {any} */ (err)?.name === 'AbortError'
        ? `The model plane did not answer within ${Math.round(timeoutMs / 1000)}s.`
        : `Could not reach the model plane at ${base}: ${/** @type {any} */ (err)?.message ?? err}`;
      opts.logger?.warn?.(message);
      return { status: 502, json: { error: { message, type: 'model_plane_unreachable' } }, text: '' };
    } finally {
      clearTimeout(timer);
    }
  }

  return { forward, base };
}

/**
 * The model plane's guard: everything except health must carry the token, and
 * the admin surface is not served at all.
 *
 * @param {{serviceToken: string, role: string}} opts
 */
export function createPlaneGuard(opts) {
  const policy = planePolicy(opts.role);

  /**
   * @param {{headers: any}} req
   * @param {string} path
   * @returns {{ok: boolean, status?: number, code?: string, message?: string}}
   */
  function check(req, path) {
    if (path === '/health' || path === '/api/status') return { ok: true };

    if (opts.role === 'model') {
      if (path.startsWith('/api/runs') || path === '/mcp') {
        return { ok: false, status: 404, code: 'not_this_plane', message: 'This is the model plane: runs and MCP belong to the agent plane.' };
      }
      const presented = req.headers?.['x-sui-plane-token'] ?? String(req.headers?.authorization ?? '').replace(/^Bearer\s+/i, '');
      if (!tokenMatches(String(presented ?? ''), opts.serviceToken)) {
        return { ok: false, status: 403, code: 'plane_token_required', message: 'The model plane serves only the agent plane. Send x-sui-plane-token.' };
      }
    }
    return { ok: true };
  }

  return { check, policy };
}

/**
 * A description of the topology, for `sui planes` and `/api/status`.
 *
 * @param {{role: string, modelPlaneUrl?: string|null, hasServiceToken?: boolean, hasProviderCredentials?: boolean}} input
 */
export function describePlane(input) {
  const policy = planePolicy(input.role);
  return {
    role: input.role,
    agentFacing: policy.agentFacing,
    holdsProviderCredentials: input.hasProviderCredentials ?? policy.holdsProviderCredentials,
    modelPlaneUrl: input.modelPlaneUrl ?? null,
    serviceTokenConfigured: Boolean(input.hasServiceToken),
    serves: policy.serves,
  };
}
