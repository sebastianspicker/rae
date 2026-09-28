-- Preserve identifiable cached replies while replacing ambiguous delimiter keys.
-- Unidentifiable historical empty claims remain stored but are not replayed.
CREATE FUNCTION pg_temp.rae_tuple(parts TEXT[]) RETURNS TEXT
LANGUAGE SQL IMMUTABLE AS $tuple$
  SELECT '[' || COALESCE(string_agg(to_json(value)::text, ',' ORDER BY ordinal), '') || ']'
  FROM unnest(parts) WITH ORDINALITY AS part(value, ordinal)
$tuple$;

DO $migration$
DECLARE
  cached RECORD;
  parts TEXT[];
  prefix TEXT;
  suffix TEXT;
  project TEXT;
  worker TEXT;
  candidates TEXT[];
  node TEXT;
  attempt RECORD;
  matches TEXT[];
  new_key TEXT;
BEGIN
  FOR cached IN SELECT key,scope,response FROM idempotency_keys ORDER BY key FOR UPDATE LOOP
    parts := NULL;
    prefix := NULL;
    IF cached.scope = 'run' THEN
      SELECT project_id INTO project FROM runs WHERE id::text=cached.response->>'id';
      IF project IS NOT NULL THEN
        parts := ARRAY['run',project];
        prefix := 'run:' || project || ':';
      END IF;
    ELSIF cached.scope = 'claim' THEN
      worker := NULL;
      IF cached.response <> 'null'::jsonb THEN
        SELECT worker_id INTO worker FROM attempts WHERE id::text=cached.response->>'attemptId';
      ELSE
        SELECT array_agg(id) INTO candidates FROM workers WHERE starts_with(cached.key,'claim:' || id || ':');
        IF cardinality(candidates)=1 THEN worker := candidates[1]; END IF;
      END IF;
      IF worker IS NOT NULL THEN
        parts := ARRAY['claim',worker];
        prefix := 'claim:' || worker || ':';
      END IF;
    ELSIF cached.scope = 'report' AND cached.key ~ '^report:[0-9a-f-]{36}:' THEN
      node := substring(cached.key FROM 8 FOR 36);
      SELECT worker_id,fence INTO attempt FROM attempts WHERE node_id::text=node AND state IN ('succeeded','failed') ORDER BY fence DESC LIMIT 1;
      IF FOUND THEN
        parts := ARRAY['report',node,attempt.worker_id,attempt.fence::text];
        prefix := 'report:' || node || ':';
      END IF;
    ELSIF cached.scope LIKE 'register:%' THEN
      parts := ARRAY['register',substring(cached.scope FROM 10)];
      prefix := cached.scope || ':';
    ELSIF cached.scope ~ '^(signal|cancel|rebind):[0-9a-f-]{36}$' THEN
      parts := string_to_array(cached.scope,':');
      prefix := cached.scope || ':';
    ELSE
      matches := regexp_match(cached.scope,'^(revision|activate):(.*):(workflow|profile)$');
      IF matches IS NOT NULL THEN parts := matches; prefix := cached.scope || ':'; END IF;
    END IF;
    IF parts IS NOT NULL AND starts_with(cached.key,prefix) THEN
      suffix := substring(cached.key FROM char_length(prefix)+1);
      new_key := pg_temp.rae_tuple(ARRAY[pg_temp.rae_tuple(parts),suffix]);
      IF NOT EXISTS (SELECT 1 FROM idempotency_keys WHERE key=new_key) THEN
        UPDATE idempotency_keys SET key=new_key WHERE key=cached.key;
      END IF;
    END IF;
  END LOOP;
END
$migration$;
DROP FUNCTION pg_temp.rae_tuple(TEXT[]);
