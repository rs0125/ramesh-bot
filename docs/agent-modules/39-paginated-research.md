# 39. Paginated research and production access

## Purpose and scope

Help an employee investigate a bounded pool across several CRM or supply pages,
retain useful partial work, and distinguish the reviewed pool from the whole
inventory. This extends the existing read executor, not its authority or tool
catalogue. No planner-generated loops, SQL, writes or WhatsApp test sends are
introduced.

The production incident on 2 October had two causes: business reads were disabled
in runtime configuration, and the restricted worker could select four employee
columns but had no roster RLS policy. Identity provisioning must install and
validate its own SELECT policy. Enabling tools must be verified with the actual
runtime role, signed employee identity, advertised catalogue and a captured answer.
Process readiness alone cannot establish business capability readiness.

## Pagination contract

- Search arguments and returned cursors remain source-owned. Prefer up to 25 rows
  for broad scans, the requested smaller count for small lookups, and concise
  warehouse results. Smaller pages remain available for large responses.
- The executor derives coverage from accepted evidence for `search_crm_leads` and
  `search_warehouses`. Group by tool plus exact filters/sort, excluding page size,
  cursor and warehouse response format. Do not merge different queries or tools.
- Count unique record IDs and duplicates across pages deterministically. An empty
  page with a continuation is not exhaustion. The coverage record describes rows
  retrieved; it does not prove the model correctly reasoned over each row.
- Mark exhaustion only for one linked traversal starting without a cursor and
  ending with a null cursor. Disconnected pages or restarted searches retain a
  partial/unlinked status. Recalled cursor pages alone do not prove full coverage.
- Detect repeated continuation tokens within a query. Preserve accepted pages,
  label the traversal stalled, and refuse another call on that cyclic cursor.
  A different filter scope starts independent accounting.
- Add coverage to worker results and formatter/verifier inputs without modifying
  original evidence or delivery fingerprints. Fresh authorization and delivery
  checks still apply to every accepted source query.
- Existing call, evidence-byte and time budgets remain. Hitting a budget or a
  failed page requires a partial-result statement, never an empty/full-inventory
  conclusion. Coverage does not make separate reads a frozen database snapshot.

## Useful synthesis

If a requested field is absent, first state that limitation. When another recorded
field supports a useful provisional comparison, name that field and its limits;
do not silently substitute it. For example, total listed space can support a
provisional shortlist, but cannot establish usable/carpet area. Preserve ranges,
units and distinct space options. If the user requires a strict field constraint,
do not describe provisional options as satisfying it.

## Evaluation before rollout

Deterministic checks cover cross-page overlap, empty pages with cursors, cycles,
disconnected recall pages, query isolation, changed page sizes, evidence immutability
and current-employee enforcement. Paid synthetic outcomes cover a useful option
past the first page, a broad review, duplicate rows, partial source failure and a
stalled cursor. Scoring concerns useful grounded results and honest coverage,
not an exact call sequence. Fixtures and case hashes enter run provenance.

Run private outcome trials through the Supabase capture queues and the production
Context Engine, bound to the operator-selected employee. Keep their cases and raw
records under ignored `.local/private-evals`; report only generic findings and
counts. Compare the original baseline with fresh runs, not a regrade presented as
an agent improvement. Tests never instantiate the Baileys sender.

## Deferred optimizations

Measure model tokens and elapsed time alongside correctness. Source result
compaction, retrievable scratch storage, connection reuse, checkpointed background
research and concurrent independent conversations need separate contracts. Do not
discard provenance, weaken delivery reauthorization or add agents just to reduce
the number of pages.
