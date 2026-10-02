-- Physically isolated capture recovery; no production queue or role access.
CREATE TABLE public."ramesh-test-agent-checkpoints" (
 message_id uuid PRIMARY KEY REFERENCES public."ramesh-test-inbound-queue"(id) ON DELETE CASCADE,
 account_id text NOT NULL,
 employee_id integer NOT NULL CHECK(employee_id>0),
 payload_encrypted text NOT NULL CHECK(octet_length(payload_encrypted)<=4194304),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 CHECK(expires_at<=created_at+interval '24 hours')
);
CREATE INDEX "ramesh-test-checkpoint-expiry" ON public."ramesh-test-agent-checkpoints"(account_id,employee_id,expires_at);
REVOKE ALL ON public."ramesh-test-agent-checkpoints" FROM PUBLIC,anon,authenticated,service_role,ramesh_worker;
GRANT SELECT,INSERT,UPDATE,DELETE ON public."ramesh-test-agent-checkpoints" TO ramesh_playground;
ALTER TABLE public."ramesh-test-agent-checkpoints" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."ramesh-test-agent-checkpoints" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ramesh-test-checkpoint-runtime" ON public."ramesh-test-agent-checkpoints" TO ramesh_playground
 USING(account_id=current_setting('ramesh.checkpoint_account',true)
   AND employee_id::text=current_setting('ramesh.checkpoint_employee',true))
 WITH CHECK(account_id=current_setting('ramesh.checkpoint_account',true)
   AND employee_id::text=current_setting('ramesh.checkpoint_employee',true));

CREATE FUNCTION public."ramesh-test-clean-agent-checkpoint"() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE previous_account text; previous_employee text;
BEGIN
 IF NEW.state IN ('COMPLETED','FAILED') THEN
  previous_account := current_setting('ramesh.checkpoint_account',true);
  previous_employee := current_setting('ramesh.checkpoint_employee',true);
  PERFORM set_config('ramesh.checkpoint_account',NEW.namespace::text,true);
  PERFORM set_config('ramesh.checkpoint_employee',NEW.employee_id::text,true);
  DELETE FROM public."ramesh-test-agent-checkpoints" WHERE message_id=NEW.id AND account_id=NEW.namespace::text AND employee_id=NEW.employee_id;
  PERFORM set_config('ramesh.checkpoint_account',coalesce(previous_account,''),true);
  PERFORM set_config('ramesh.checkpoint_employee',coalesce(previous_employee,''),true);
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public."ramesh-test-clean-agent-checkpoint"() FROM PUBLIC,anon,authenticated,service_role,ramesh_worker;
GRANT EXECUTE ON FUNCTION public."ramesh-test-clean-agent-checkpoint"() TO ramesh_playground;
CREATE TRIGGER "ramesh-test-clean-agent-checkpoint" AFTER UPDATE OF state ON public."ramesh-test-inbound-queue"
 FOR EACH ROW WHEN (NEW.state IN ('COMPLETED','FAILED')) EXECUTE FUNCTION public."ramesh-test-clean-agent-checkpoint"();
