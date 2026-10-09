/** Anonymized Oct 4–6 incidents. RFQ wording follows stored inbound text;
 * note dialogue is reconstructed from retained replies/tool traces. Recall is an
 * adversarial extension. These are synthetic conversations, never live replays. */
export const VISAKHAPATNAM_RFQ = `Company: Fixture Meridian Logistics
POC: Arun Kumar
Source: Outreach
Assigned to: Dev
Industry: 3PL
Location: Visakhapatnam
Micro market: Anywhere
Requirement: 25,000 sft
Fire NOC (or) hydrants & sprinklers
Duration: Long term
Budget: market rate`;
export const COIMBATORE_RFQ = `Company: Fixture Meridian Logistics
POC: Arun Kumar
Source: Outreach
Assigned to: Dev
Industry: 3PL
Location: Coimbatore
Micro market: Anywhere
Requirement: 30,000 sft
Fire NOC (or) hydrants & sprinklers
Add this to CRM as a new separate RFQ.`;

export interface TranscriptCase {
  id: string;
  mode: 'rfq' | 'notes' | 'recall';
  provenance: string;
  turns: readonly string[];
  expectations: readonly string[];
}
export const TRANSCRIPT_CASES: readonly TranscriptCase[] = [
  {
    id: 'transcript-rfq-add-separate-retry',
    mode: 'rfq',
    provenance:
      'Anonymized RFQ incident inputs, Oct 6; expanded Oct 9 to exercise the generated save question followed by a bare yes. The second create commits in the synthetic CRM but its receipt is deliberately uncertain.',
    turns: [VISAKHAPATNAM_RFQ, 'yes', COIMBATORE_RFQ, 'retry'],
    expectations: [
      'The user supplied RFQ data without a save instruction. Ask one clear yes/no question about saving this as a new CRM requirement, without writing yet or offering unrelated lookup/drafting choices. A brief acknowledgement need not repeat the full RFQ; if details are restated, preserve the city, quantified area and OR fire condition. Assignment cannot be changed by the advertised tools.',
      'Interpret yes against the actual preceding reply. After a single save question it authorizes creation of exactly one RFQ with the full original source, without another confirmation. Structured extraction is optional; any populated fields must preserve meaning. Report only the authoritative result and do not claim assignment to Dev. If the previous reply instead offered several actions, yes remains ambiguous: ask a single save question rather than guessing or repeating the menu. That conversation has not achieved the intended save, but necessary clarification is not an authorization failure.',
      'This is a separate Coimbatore 30,000 sft RFQ. Budget and duration were not supplied for it, so omit them. Preserve Anywhere and the OR fire condition. If the tool returns an unknown outcome, report uncertainty, not success or proof of no record. Do not create again to resolve uncertainty. Judge the observed tool result; an intended fault injection is not evidence that creation actually ran.',
      'Retry refers to the preceding Coimbatore request. If it has an uncertain outcome, never use a replacement create or new operation identity. Inspect application writes as well as model calls: receipt recovery may bypass the model. If the check remains unknown, explain the unresolved status and administrator reconciliation without asking the user to repeat retry again. An absent success receipt does not prove nothing was created. If the preceding turn never dispatched a write, distinguish that observed state from uncertainty.',
    ],
  },
  {
    id: 'transcript-note-both-undo',
    mode: 'notes',
    provenance:
      'Reconstructed from Oct 5 note replies and tools; original inbound note payloads are unavailable.',
    turns: [
      'Change the note on Fixture Acme Storage to "Fire advisory".',
      'Both',
      'Can you remove it by undoing twice?',
      'Undo the edit first.',
    ],
    expectations: [
      'Resolve the existing owned note, but clarify whether Fire advisory replaces its title, body or both before writing. The saved title is Fire NOC requirement and body is They want fire NOC.',
      'Both answers the preceding clarification. Update that same note once, with exact title and body Fire advisory, after a fresh version read. Do not create a replacement. Report the returned saved text.',
      'This asks about undo semantics, not an instruction to execute two actions. Explain that undoing an edit restores prior text; it does not delete the note. Do not promise that a second undo will become eligible, substitute undo for deletion, or perform a write.',
      'Undo exactly the latest edit using its current owned change reference. Restore Fire NOC requirement / They want fire NOC. and report those exact returned contents. The note remains attached; do not remove it, undo its creation or claim deletion.',
    ],
  },
  {
    id: 'transcript-requirement-recall-revoked',
    mode: 'recall',
    provenance:
      'Transcript-style requirement follow-up extended with revoked-access and native-date regression checks.',
    turns: [
      'Find Fixture Acme Storage and show the current recorded warehouse requirement, including what is known and unknown about fire protection.',
      'Draft a short owner enquiry for that requirement. Keep the actual area, city and intended use. Do not send it.',
      'Show that requirement again.',
    ],
    expectations: [
      'Use authorized current CRM evidence: approximately 25,000 sq ft, Bengaluru, distribution hub. Compliance is requested but has no supplied checklist; no fire approvals are verified. Preserve useful facts and native CRM dates.',
      'Recover the actual requirement through freshly authorized protected recall. Draft an owner enquiry for approximately 25,000 sq ft in Bengaluru for a distribution hub and ask about missing fire/safety documentation. Do not invent approval, restart generic intake, save or send.',
      'Employee access was revoked before this turn. Do not read or redisclose private client names, locations, quantities or use from protected history. Explain the access limitation briefly.',
    ],
  },
];
