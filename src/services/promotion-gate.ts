/**
 * Promotion gate — the bar something must clear before DAMC presents it as a
 * fact the hub knows, rather than a candidate it has merely recorded.
 *
 * Status is not cosmetic here. `active` and `confirmed` memories are what
 * context_pack, active_decisions, session_start and GET /v1/state hand to every
 * connected AI as settled truth, and an active DECISION is what a later
 * statement is allowed to supersede. So two different mistakes have to be
 * impossible:
 *
 *   1. A guess entering shared memory as a standing fact. The ingestion
 *      pipeline reaches DECISION by pattern-matching chat text; a sentence that
 *      merely implies an outcome ("Database is PostgreSQL", a bare "확정")
 *      must be kept as a candidate for review, not published to every client.
 *   2. A guess *destroying* a real decision. Supersession retires the previous
 *      memory. Letting an inferred extraction do that means one loose regex
 *      match can silently retire something a person actually declared.
 *
 * The gate therefore grades on evidence, not only on a confidence number. The
 * extraction pipeline assigns every heuristic candidate the same placeholder
 * confidence, so confidence alone cannot separate "someone said they decided
 * this" from "this sentence looks a bit like a decision" — see
 * text-classification.ts's EvidenceStrength for the distinction that can.
 *
 * Nothing here deletes or rewrites anything: a blocked candidate is still
 * stored, with its provenance, as `candidate`. It is withheld from the settled
 * set, not discarded.
 */

import type { EvidenceStrength } from './text-classification.js';
import type { MemoryStatus, MemoryType } from '../types/domain.js';

/**
 * Types whose `active` state means "this is the standing answer". Only these
 * are promoted on write, and only these participate in supersession — the same
 * set memory-engine.ts runs conflict detection over.
 */
const STANDING_TYPES: ReadonlySet<MemoryType> = new Set<MemoryType>(['DECISION', 'RULE', 'CONSTRAINT']);

/**
 * Floor for entering the settled set. Independent of the evidence check: it
 * catches a caller that asserts a decision directly (MCP `decision_create`,
 * POST /v1) while telling DAMC it is barely sure. Heuristic extraction sits
 * above this floor and is gated by evidence instead.
 */
export const PROMOTION_MIN_CONFIDENCE = 0.5;

export interface PromotionInput {
  type: MemoryType;
  confidence: number;
  /**
   * How firmly the source settled the matter. `undefined` means the caller
   * asserted the memory directly rather than DAMC extracting it from prose —
   * an AI client calling `decision_create` is itself an explicit statement, so
   * the absence of a grade is treated as explicit. Only the extraction pipeline
   * supplies this field, and it supplies it for every candidate.
   */
  evidence?: EvidenceStrength | null;
}

function isExplicit(evidence: PromotionInput['evidence']): boolean {
  return evidence === undefined || evidence === null ? true : evidence === 'explicit';
}

/**
 * May this memory enter the settled set (`active`) on write?
 *
 * Both conditions must hold, and they block different mistakes: evidence stops
 * a pattern match from becoming a fact, confidence stops a caller from
 * publishing something it has already told us is a guess.
 */
export function mayPromoteToActive(input: PromotionInput): boolean {
  if (!STANDING_TYPES.has(input.type)) return false;
  if (!isExplicit(input.evidence)) return false;
  return input.confidence >= PROMOTION_MIN_CONFIDENCE;
}

/** Status a newly written memory starts in. Everything the gate withholds stays a candidate. */
export function initialStatus(input: PromotionInput): MemoryStatus {
  return mayPromoteToActive(input) ? 'active' : 'candidate';
}

/**
 * May this memory retire an existing active/confirmed one?
 *
 * Deliberately the same bar as promotion. Superseding is a stronger act than
 * being recorded — it changes what every client is told is current — so
 * anything not trusted enough to *be* the standing answer is not trusted enough
 * to replace it either. memory-engine.ts records the disagreement as a
 * CONFLICTS_WITH relation instead, leaving both memories intact for review.
 */
export function mayAutoSupersede(input: PromotionInput): boolean {
  return mayPromoteToActive(input);
}

/**
 * Why the gate withheld promotion, for the memory's own metadata. Stored so the
 * reason a candidate is still a candidate is answerable later without re-running
 * the classifier.
 */
export function withholdReason(input: PromotionInput): string | null {
  if (mayPromoteToActive(input)) return null;
  if (!STANDING_TYPES.has(input.type)) return 'type_not_standing';
  if (!isExplicit(input.evidence)) return 'inferred_evidence';
  return 'below_confidence_floor';
}
