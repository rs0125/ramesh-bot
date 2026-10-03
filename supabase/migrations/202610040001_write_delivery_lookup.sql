-- Receipt handoff checks are scoped to the inbound run, including terminal writes.
-- Performance only: older schemas already contain every column used by the guard.
CREATE INDEX ramesh_write_events_run_idx
  ON public."ramesh-write-events" (account_id,run_id,operation_id)
  WHERE operation_id IS NOT NULL;
