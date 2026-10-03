-- Trusted personal command provenance has a shorter lifetime than mutation receipts.
-- Context is never an instruction to execute: a new direct command must authorize each write.
ALTER TABLE public."ramesh-assistant-commands" DROP CONSTRAINT "ramesh-assistant-commands_kind_check";
ALTER TABLE public."ramesh-assistant-commands" ADD CONSTRAINT "ramesh-assistant-commands_kind_check"
 CHECK(kind IN('mutation','selection','context'));
CREATE UNIQUE INDEX "ramesh-one-personal-context" ON public."ramesh-assistant-commands"(account_id,run_id) WHERE kind='context';
CREATE INDEX "ramesh-personal-context-owner" ON public."ramesh-assistant-commands"(account_id,owner_employee_id,created_at DESC) WHERE kind='context';
