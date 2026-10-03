# CRM RFQ write integration

Context Engine owns `create_crm_rfq`, its intake SOP, `crm.rfq:write` permission and the Twenty adapter. Ramesh uses the existing generic business-write executor. This branch adds optional `sourceTextArgument` metadata so domains can require complete source text in a specified argument.

New inbox messages and captions now retain leading/trailing whitespace during WhatsApp mapping, so the encrypted source matches the incoming text. Greeting-only normalization is unchanged. Older inbox records retain whatever text was previously stored; missing historical whitespace cannot be reconstructed.

For RFQs that argument is `raw_text`. Ramesh hides it from the model's input schema and fills it directly from the complete stored text selected by `_source_message_ids` / `write_sources`. This happens before persistence, hashing, verification and the user review. Multiple messages join in selection order with two newlines. Whitespace and `#twenty` tags are retained; a model-supplied replacement is rejected. Source length and content constraints are checked before a proposal is stored, without truncation. Without explicit selection, the current authorized source is used. Historical/forwarded sources provide data and cannot authorize a write.

The current direct-message authorization, independent proposal verification, exact later confirmation, encrypted journal and frozen UUID/arguments remain in charge. The tool does not declare `auditHistory`; a create grant cannot redisclose rich CRM history or support an undo preview. CRM-specific audit/history and reversal were explicitly deferred. No CRM update, note, delete or rollback capability is added.

Context Engine requires a specific location and quantified space/capacity with a unit. A named locality/corridor is sufficient when city is unknown. Company, contact, budget, duration, source and repeat-client status remain optional. The full raw message becomes `description`; only exact integer sqft requirements populate Twenty's numeric area field. New records always start at `RFQ_RECEIVED`.

The OAuth vocabulary now accepts explicit `crm.rfq:write`; enrollment still defaults to `crm:read` and refresh cannot enlarge grants. Signed-request ceilings already support this syntax but must explicitly include the new scope. Deploy the companion Context Engine branch and configure its receipt migration, scope migrations and separate write credential before enabling the tool. This branch is not a live rollout.

Recovery returns the original receipt without another POST. If the original response could not be persisted, retain the uncertain operation for administrator reconciliation; never generate a new UUID just to retry a timeout. The journal is not an atomic transaction with Twenty and cannot undo a committed creation.

If an attempt was explicitly not dispatched and has no earlier uncertain attempt, Ramesh shows the public error code and offers cancellation for a corrected proposal or a retry after temporary access/service recovery. It does not redisplay stored RFQ details or upstream messages. An earlier uncertain attempt continues to require recovery with the same operation, even when the latest attempt was not dispatched.

Full setup, SOP evidence and extension boundaries are in Context Engine's `docs/crm-rfq-writes.md`. When merging the independent mail work, retain both OAuth capabilities and both sets of executor changes. Model-free tests cover exact source preservation, forwarded/historical selection, confirmation and grant narrowing.
