import type { MiddlewareHandler } from 'hono';
import { TokenRejectedError, verifyToken } from './tokens.js';
import type { KeyRegistry, VerifiedToken, VerifyOptions } from './tokens.js';

/**
 * Hono middleware over the framework-agnostic verifier.
 *
 * Deliberately thin. Everything that decides whether a token is acceptable
 * lives in `tokens.ts` and is tested without an HTTP server; this layer only
 * moves a string out of a header and a result into the context.
 */

export interface AuthVariables {
  token: VerifiedToken;
}

export function requireToken(
  registry: KeyRegistry,
  options: VerifyOptions = {},
): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    const header = c.req.header('Authorization');
    const bearer = /^Bearer (.+)$/i.exec(header ?? '')?.[1];

    if (!bearer) {
      return c.json({ error: 'unauthorized' }, 401, {
        'WWW-Authenticate': 'Bearer realm="gnomon"',
      });
    }

    try {
      c.set('token', await verifyToken(bearer, registry, options));
    } catch (error) {
      if (error instanceof TokenRejectedError) {
        // The reason is deliberately NOT returned. Distinguishing "unknown
        // key" from "bad signature" tells an attacker which half of their
        // guess was right; it belongs in logs, not in the response.
        return c.json({ error: 'unauthorized' }, 401, {
          'WWW-Authenticate': 'Bearer realm="gnomon"',
        });
      }
      throw error;
    }

    await next();
  };
}
