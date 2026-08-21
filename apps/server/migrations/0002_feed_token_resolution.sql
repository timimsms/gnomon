-- Resolving a feed token before any tenant is known (phase 5.1).
--
-- ---------------------------------------------------------------------------
-- THE PROBLEM
--
-- An ICS feed request carries no JWT. Its only credential is the opaque token
-- in the URL, so the tenant is not known until that token has been looked up.
-- But `feed_tokens` is covered by RLS (0001), and those policies read
-- `gnomon.tenant_id` -- which is exactly what we are trying to discover. A
-- plain SELECT before the context is set matches zero rows, so every feed
-- would 404.
--
-- This is the same shape as `tenant_keys`, which is excluded from RLS
-- entirely for the same reason. A different answer is available here, and a
-- better one.
--
-- ---------------------------------------------------------------------------
-- THE ANSWER
--
-- One SECURITY DEFINER function, narrow enough to reason about: it takes a
-- token HASH and returns nothing but the tenant and calendar it belongs to.
-- The table keeps its RLS policy for every other access path, so listing,
-- creating and revoking feeds remain tenant-scoped as normal.
--
-- Knowing the hash means holding the token, which is the credential. The
-- function therefore reveals nothing to a caller who did not already have it,
-- and it cannot be used to enumerate: there is no way to ask it for "all
-- tokens", only to present one and be told whose it is.
--
-- `SET search_path` is not optional on a SECURITY DEFINER function. Without
-- it, a caller who can create objects in an earlier schema can shadow `=` or
-- `feed_tokens` and have their own code run as the function's owner.

CREATE OR REPLACE FUNCTION gnomon_resolve_feed_token(p_token_hash text)
RETURNS TABLE (tenant_id text, calendar_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT f.tenant_id, f.calendar_id
    FROM feed_tokens f
   WHERE f.token_hash = p_token_hash
     -- Revocation must take effect on the next poll. Omitting this is how a
     -- revoked feed keeps working for ever and nobody notices.
     AND f.revoked_at IS NULL
   LIMIT 1;
$$;--> statement-breakpoint

COMMENT ON FUNCTION gnomon_resolve_feed_token(text) IS
  'Resolves an ICS feed token hash to its tenant and calendar. SECURITY DEFINER because RLS policies read a tenant that is not known until this returns. See migration 0002.';
