-- Conversation source data is separate from immutable action/audit records.
CREATE TABLE public."ramesh-conversation-context" (
 account_id text NOT NULL,
 scope_key text NOT NULL CHECK(scope_key ~ '^[a-f0-9]{64}$'),
 owner_binding text NOT NULL CHECK(owner_binding ~ '^[a-f0-9]{64}$'),
 employee_id integer NOT NULL CHECK(employee_id>0),
 revision integer NOT NULL CHECK(revision>0),
 payload_encrypted text NOT NULL CHECK(octet_length(payload_encrypted)<=262144),
 has_pins boolean NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(account_id,scope_key)
);
CREATE INDEX "ramesh-conversation-context-age" ON public."ramesh-conversation-context"(account_id,updated_at);
REVOKE ALL ON public."ramesh-conversation-context" FROM PUBLIC,anon,authenticated,service_role;
DO $migration$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ramesh_playground') THEN
  REVOKE ALL ON public."ramesh-conversation-context" FROM ramesh_playground;
 END IF;
END
$migration$;
GRANT SELECT,INSERT,UPDATE,DELETE ON public."ramesh-conversation-context" TO ramesh_worker;
ALTER TABLE public."ramesh-conversation-context" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."ramesh-conversation-context" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ramesh-conversation-context-runtime" ON public."ramesh-conversation-context" TO ramesh_worker
 USING(account_id=current_setting('ramesh.context_account',true))
 WITH CHECK(account_id=current_setting('ramesh.context_account',true));
