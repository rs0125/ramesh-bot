CREATE TABLE public."ramesh-test-media" (
 id uuid PRIMARY KEY, namespace text NOT NULL, owner_hash text NOT NULL CHECK(owner_hash ~ '^[a-f0-9]{64}$'),
 source_id text NOT NULL,content_hash text NOT NULL,byte_length integer NOT NULL CHECK(byte_length BETWEEN 1 AND 8388608),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN('pending','processing','ready','failed')),
 upload_encrypted text NOT NULL,extract_encrypted text,failure_code text,lease_token uuid,lease_until timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '24 hours',
 UNIQUE(namespace,owner_hash,source_id),CHECK((state='processing')=(lease_token IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX "ramesh-test-media-expiry" ON public."ramesh-test-media"(namespace,expires_at);
REVOKE ALL ON public."ramesh-test-media" FROM PUBLIC,anon,authenticated,service_role,ramesh_worker;
GRANT SELECT,INSERT,UPDATE,DELETE ON public."ramesh-test-media" TO ramesh_playground;
ALTER TABLE public."ramesh-test-media" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ramesh-test-media-runtime" ON public."ramesh-test-media" TO ramesh_playground USING(true) WITH CHECK(true);

ALTER TABLE public."ramesh-test-inbound-queue"
 ADD COLUMN batch_parent uuid REFERENCES public."ramesh-test-inbound-queue"(id) ON DELETE CASCADE,
 ADD COLUMN available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 ADD COLUMN batch_closed boolean NOT NULL DEFAULT false,
 ADD COLUMN batch_count integer NOT NULL DEFAULT 1,
 ADD COLUMN batch_chars integer NOT NULL DEFAULT 0,
 ADD COLUMN media_ids uuid[] NOT NULL DEFAULT '{}',
 ADD COLUMN forwarded boolean NOT NULL DEFAULT false;
CREATE INDEX "ramesh-test-inbound-batch-parent" ON public."ramesh-test-inbound-queue"(batch_parent);
