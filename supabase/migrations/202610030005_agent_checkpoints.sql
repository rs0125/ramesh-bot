-- Replay completed model responses only; tools and employee permissions are rechecked on retry.
CREATE TABLE public."ramesh-agent-checkpoints" (
 message_id uuid PRIMARY KEY REFERENCES public."ramesh-inbound-queue"(message_id) ON DELETE CASCADE,
 account_id text NOT NULL,
 employee_id integer NOT NULL DEFAULT 0 CHECK(employee_id=0),
 payload_encrypted text NOT NULL CHECK(octet_length(payload_encrypted)<=4194304),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 FOREIGN KEY(account_id,message_id) REFERENCES public."ramesh-messages"(account_id,id) ON DELETE CASCADE,
 CHECK(expires_at<=created_at+interval '24 hours')
);
CREATE INDEX "ramesh-checkpoint-expiry" ON public."ramesh-agent-checkpoints"(account_id,expires_at);
REVOKE ALL ON public."ramesh-agent-checkpoints" FROM PUBLIC,anon,authenticated,service_role;
DO $migration$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ramesh_playground') THEN
  REVOKE ALL ON public."ramesh-agent-checkpoints" FROM ramesh_playground;
 END IF;
END
$migration$;
GRANT SELECT,INSERT,UPDATE,DELETE ON public."ramesh-agent-checkpoints" TO ramesh_worker;
ALTER TABLE public."ramesh-agent-checkpoints" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."ramesh-agent-checkpoints" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ramesh-checkpoint-runtime" ON public."ramesh-agent-checkpoints" TO ramesh_worker
 USING(account_id=current_setting('ramesh.checkpoint_account',true))
 WITH CHECK(account_id=current_setting('ramesh.checkpoint_account',true));

-- Run as the queue role, preserving its prior transaction-local RLS binding.
CREATE FUNCTION public."ramesh-clean-agent-checkpoint"() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE previous_account text;
BEGIN
 IF NEW.state IN ('DONE','DEAD') THEN
  previous_account := current_setting('ramesh.checkpoint_account',true);
  PERFORM set_config('ramesh.checkpoint_account',NEW.account_id,true);
  DELETE FROM public."ramesh-agent-checkpoints" WHERE message_id=NEW.message_id AND account_id=NEW.account_id;
  PERFORM set_config('ramesh.checkpoint_account',coalesce(previous_account,''),true);
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public."ramesh-clean-agent-checkpoint"() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public."ramesh-clean-agent-checkpoint"() TO ramesh_worker;
CREATE TRIGGER "ramesh-clean-agent-checkpoint" AFTER UPDATE OF state ON public."ramesh-inbound-queue"
 FOR EACH ROW WHEN (NEW.state IN ('DONE','DEAD')) EXECUTE FUNCTION public."ramesh-clean-agent-checkpoint"();
