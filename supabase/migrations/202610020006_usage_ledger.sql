-- Ledger amounts are integer USD millionths. Never persist prompts, media or credentials here.
CREATE TABLE public."ramesh-usage-requests" (
 id uuid PRIMARY KEY,
 account_id text NOT NULL CHECK(length(account_id) BETWEEN 1 AND 512),
 purpose text NOT NULL CHECK(purpose IN('production','playground','evaluation')),
 run_id text NOT NULL CHECK(length(run_id) BETWEEN 1 AND 512),
 attempt bigint NOT NULL DEFAULT 0 CHECK(attempt BETWEEN 0 AND 9007199254740991),
 state text NOT NULL DEFAULT 'reserved' CHECK(state IN('reserved','settled','unknown')),
 reserved_micros bigint CHECK(reserved_micros BETWEEN 0 AND 9007199254740991),
 actual_micros bigint CHECK(actual_micros BETWEEN 0 AND 9007199254740991),
 reservation jsonb NOT NULL CHECK(jsonb_typeof(reservation)='object'),
 settlement jsonb CHECK(jsonb_typeof(settlement)='object'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 settled_at timestamptz,
 UNIQUE(id,account_id,purpose),
 CHECK((state='settled')=(actual_micros IS NOT NULL)),
 CHECK((state='reserved')=(settlement IS NULL)),
 CHECK((state='reserved')=(settled_at IS NULL))
);
CREATE INDEX "ramesh-usage-run" ON public."ramesh-usage-requests"(account_id,purpose,run_id);

CREATE TABLE public."ramesh-usage-buckets" (
 request_id uuid NOT NULL,
 account_id text NOT NULL,
 purpose text NOT NULL,
 bucket_key text NOT NULL CHECK(length(bucket_key) BETWEEN 1 AND 512),
 PRIMARY KEY(request_id,bucket_key),
 FOREIGN KEY(request_id,account_id,purpose)
   REFERENCES public."ramesh-usage-requests"(id,account_id,purpose)
);
CREATE INDEX "ramesh-usage-budget" ON public."ramesh-usage-buckets"(account_id,purpose,bucket_key);

REVOKE ALL ON public."ramesh-usage-requests",public."ramesh-usage-buckets"
 FROM PUBLIC,anon,authenticated,service_role;
DO $migration$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ramesh_playground') THEN
  REVOKE ALL ON public."ramesh-usage-requests",public."ramesh-usage-buckets" FROM ramesh_playground;
 END IF;
END
$migration$;
GRANT SELECT,INSERT ON public."ramesh-usage-requests",public."ramesh-usage-buckets" TO ramesh_worker;
GRANT UPDATE(state,actual_micros,settlement,settled_at) ON public."ramesh-usage-requests" TO ramesh_worker;
ALTER TABLE public."ramesh-usage-requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."ramesh-usage-requests" FORCE ROW LEVEL SECURITY;
ALTER TABLE public."ramesh-usage-buckets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."ramesh-usage-buckets" FORCE ROW LEVEL SECURITY;
-- The trusted service binds both settings within each transaction. Missing scope sees no rows.
CREATE POLICY "ramesh-usage-requests-runtime" ON public."ramesh-usage-requests" TO ramesh_worker
 USING(account_id=current_setting('ramesh.usage_account',true)
   AND purpose=current_setting('ramesh.usage_purpose',true))
 WITH CHECK(account_id=current_setting('ramesh.usage_account',true)
   AND purpose=current_setting('ramesh.usage_purpose',true));
CREATE POLICY "ramesh-usage-buckets-runtime" ON public."ramesh-usage-buckets" TO ramesh_worker
 USING(account_id=current_setting('ramesh.usage_account',true)
   AND purpose=current_setting('ramesh.usage_purpose',true))
 WITH CHECK(account_id=current_setting('ramesh.usage_account',true)
   AND purpose=current_setting('ramesh.usage_purpose',true));
