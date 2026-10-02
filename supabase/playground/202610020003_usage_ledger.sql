-- Dedicated capture accounting. No production table grants or delivery path.
-- Ledger amounts are integer USD millionths. Never persist prompts, media or credentials here.
CREATE TABLE public."ramesh-test-usage-requests" (
 id uuid PRIMARY KEY,
 account_id text NOT NULL CHECK(length(account_id) BETWEEN 1 AND 512),
 purpose text NOT NULL CHECK(purpose IN('playground','evaluation')),
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
CREATE INDEX "ramesh-test-usage-run" ON public."ramesh-test-usage-requests"(account_id,purpose,run_id);

CREATE TABLE public."ramesh-test-usage-buckets" (
 request_id uuid NOT NULL,
 account_id text NOT NULL,
 purpose text NOT NULL,
 bucket_key text NOT NULL CHECK(length(bucket_key) BETWEEN 1 AND 512),
 PRIMARY KEY(request_id,bucket_key),
 FOREIGN KEY(request_id,account_id,purpose)
   REFERENCES public."ramesh-test-usage-requests"(id,account_id,purpose)
);
CREATE INDEX "ramesh-test-usage-budget" ON public."ramesh-test-usage-buckets"(account_id,purpose,bucket_key);

REVOKE ALL ON public."ramesh-test-usage-requests",public."ramesh-test-usage-buckets"
 FROM PUBLIC,anon,authenticated,service_role,ramesh_worker;

GRANT SELECT,INSERT ON public."ramesh-test-usage-requests",public."ramesh-test-usage-buckets" TO ramesh_playground;
GRANT UPDATE(state,actual_micros,settlement,settled_at) ON public."ramesh-test-usage-requests" TO ramesh_playground;
ALTER TABLE public."ramesh-test-usage-requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."ramesh-test-usage-requests" FORCE ROW LEVEL SECURITY;
ALTER TABLE public."ramesh-test-usage-buckets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."ramesh-test-usage-buckets" FORCE ROW LEVEL SECURITY;
-- The trusted service binds both settings within each transaction. Missing scope sees no rows.
CREATE POLICY "ramesh-test-usage-requests-runtime" ON public."ramesh-test-usage-requests" TO ramesh_playground
 USING(account_id=current_setting('ramesh.usage_account',true)
   AND purpose=current_setting('ramesh.usage_purpose',true))
 WITH CHECK(account_id=current_setting('ramesh.usage_account',true)
   AND purpose=current_setting('ramesh.usage_purpose',true));
CREATE POLICY "ramesh-test-usage-buckets-runtime" ON public."ramesh-test-usage-buckets" TO ramesh_playground
 USING(account_id=current_setting('ramesh.usage_account',true)
   AND purpose=current_setting('ramesh.usage_purpose',true))
 WITH CHECK(account_id=current_setting('ramesh.usage_account',true)
   AND purpose=current_setting('ramesh.usage_purpose',true));
