CREATE TABLE public."ramesh-media" (
 id uuid PRIMARY KEY, namespace text NOT NULL, owner_hash text NOT NULL CHECK(owner_hash ~ '^[a-f0-9]{64}$'),
 source_id text NOT NULL,content_hash text NOT NULL,byte_length integer NOT NULL CHECK(byte_length BETWEEN 1 AND 8388608),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN('pending','processing','ready','failed')),
 upload_encrypted text NOT NULL,extract_encrypted text,failure_code text,lease_token uuid,lease_until timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '24 hours',
 UNIQUE(namespace,owner_hash,source_id),CHECK((state='processing')=(lease_token IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX "ramesh-media-expiry" ON public."ramesh-media"(namespace,expires_at);
REVOKE ALL ON public."ramesh-media" FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE,DELETE ON public."ramesh-media" TO ramesh_worker;
ALTER TABLE public."ramesh-media" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ramesh-media-runtime" ON public."ramesh-media" TO ramesh_worker USING(true) WITH CHECK(true);

ALTER TABLE public."ramesh-inbound-queue"
 ADD COLUMN batch_parent uuid REFERENCES public."ramesh-messages"(id) ON DELETE CASCADE,
 ADD COLUMN sender_key text,
 ADD COLUMN batch_closed boolean NOT NULL DEFAULT false,
 ADD COLUMN batch_count integer NOT NULL DEFAULT 1,
 ADD COLUMN batch_chars integer NOT NULL DEFAULT 0,
 ADD COLUMN media_count integer NOT NULL DEFAULT 0;
CREATE INDEX "ramesh-inbound-batch-parent" ON public."ramesh-inbound-queue"(batch_parent);
