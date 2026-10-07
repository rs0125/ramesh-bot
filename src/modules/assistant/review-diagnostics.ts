/** Fixed verifier diagnostics only. Never persist reviewer prose or rejected answer text. */
import { z } from 'zod';

export const reviewFailure = z.enum([
  'none',
  'unsupported_claim',
  'missing_evidence',
  'incomplete_answer',
  'presentation',
  'access',
  'other',
]);
export type ReviewFailure = z.infer<typeof reviewFailure>;
export interface ReviewMetric {
  approved: boolean;
  repair: 'none' | 'format' | 'evidence' | 'tools';
  reason: ReviewFailure;
  presentationIssueCount: number;
}

/** Explicit projection prevents extra model fields from reaching the stage logger. */
export function reviewMetric(
  review: { supported: unknown; repair?: unknown; reason?: unknown },
  presentationIssueCount: number,
): ReviewMetric {
  const count = Number.isFinite(presentationIssueCount)
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(presentationIssueCount)))
    : 0;
  const approved = review.supported === true && count === 0;
  if (approved)
    return { approved: true, repair: 'none', reason: 'none', presentationIssueCount: 0 };
  if (review.supported === true && count > 0)
    return {
      approved: false,
      repair: 'format',
      reason: 'presentation',
      presentationIssueCount: count,
    };
  const parsedReason = reviewFailure.safeParse(review.reason);
  return {
    approved: false,
    repair:
      review.repair === 'none' || review.repair === 'format' || review.repair === 'evidence'
        ? review.repair
        : 'tools',
    reason: parsedReason.success && parsedReason.data !== 'none' ? parsedReason.data : 'other',
    presentationIssueCount: count,
  };
}

/** A failed review cannot turn its draft, feedback, or source values into a user-facing reply. */
export function reviewFailureReply(input: {
  hasEvidence: boolean;
  reason: ReviewFailure;
  researchExhausted: boolean;
}): string {
  if (input.hasEvidence) {
    if (input.researchExhausted)
      return "I retrieved information, but couldn't finish verifying my answer in this run.";
    if (input.reason === 'incomplete_answer')
      return "I retrieved information, but couldn't verify an answer that covers your full request.";
    if (input.reason === 'missing_evidence')
      return "I retrieved some information, but don't have enough verified evidence to answer your request.";
    if (input.reason === 'presentation')
      return "I retrieved information, but couldn't produce a clear, verified answer from it.";
    return "I retrieved information, but couldn't verify my answer to your request.";
  }
  if (input.reason === 'access')
    return "I couldn't verify access to the information needed to answer this.";
  if (input.researchExhausted)
    return "I couldn't complete the checks needed to answer this within this run.";
  if (input.reason === 'missing_evidence')
    return "I couldn't retrieve enough verified information to answer this.";
  return "I couldn't verify my answer to your request.";
}
