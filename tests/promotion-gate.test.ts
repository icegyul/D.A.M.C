import { describe, expect, it } from 'vitest';
import { mayPromoteToActive, mayAutoSupersede, initialStatus, withholdReason, PROMOTION_MIN_CONFIDENCE } from '../src/services/promotion-gate.js';
import { gradeEvidence, classifyMessage } from '../src/services/text-classification.js';
import { extractCandidates } from '../src/services/ingestion-service.js';

const conversation = (texts: string[]) => ({
  provider: 'chatgpt',
  externalId: 'promotion-gate',
  messages: texts.map((content, i) => ({ role: 'user' as const, content, sequenceNo: i }))
});

/**
 * The gate exists so a pattern match cannot become a fact, and cannot retire one.
 * These tests pin both halves.
 */
describe('promotion gate', () => {
  it('promotes an explicitly stated decision', () => {
    expect(mayPromoteToActive({ type: 'DECISION', confidence: 0.55, evidence: 'explicit' })).toBe(true);
    expect(initialStatus({ type: 'DECISION', confidence: 0.55, evidence: 'explicit' })).toBe('active');
  });

  it('withholds a decision that was only inferred, keeping it as a candidate', () => {
    const inferred = { type: 'DECISION' as const, confidence: 0.55, evidence: 'inferred' as const };
    expect(mayPromoteToActive(inferred)).toBe(false);
    expect(initialStatus(inferred)).toBe('candidate');
    expect(withholdReason(inferred)).toBe('inferred_evidence');
  });

  it('withholds an explicit decision whose caller reported low confidence', () => {
    const unsure = { type: 'DECISION' as const, confidence: PROMOTION_MIN_CONFIDENCE - 0.01, evidence: 'explicit' as const };
    expect(mayPromoteToActive(unsure)).toBe(false);
    expect(withholdReason(unsure)).toBe('below_confidence_floor');
  });

  it('treats a caller that asserts a memory directly as explicit', () => {
    // No evidence grade at all: an AI client calling decision_create is itself
    // the explicit statement. Only the extraction pipeline supplies a grade.
    expect(mayPromoteToActive({ type: 'DECISION', confidence: 0.85 })).toBe(true);
    expect(mayPromoteToActive({ type: 'DECISION', confidence: 0.85, evidence: null })).toBe(true);
  });

  it('never promotes a type whose active state is not a standing answer', () => {
    for (const type of ['TASK', 'KNOWLEDGE', 'HISTORY', 'EVENT'] as const) {
      expect(mayPromoteToActive({ type, confidence: 0.99, evidence: 'explicit' }), type).toBe(false);
      expect(initialStatus({ type, confidence: 0.99, evidence: 'explicit' }), type).toBe('candidate');
    }
  });

  it('promotes the standing types the conflict engine compares', () => {
    // memory-engine runs supersession over exactly DECISION/RULE/CONSTRAINT, so
    // the promotion set has to be the same three or a rule could supersede
    // without ever being able to be the standing answer itself.
    for (const type of ['DECISION', 'RULE', 'CONSTRAINT'] as const) {
      expect(mayPromoteToActive({ type, confidence: 0.8, evidence: 'explicit' }), type).toBe(true);
    }
  });

  /**
   * The rule that protects existing memory: superseding retires a memory, so it
   * demands at least as much evidence as being recorded as current.
   */
  it('holds supersession to the same bar as promotion', () => {
    expect(mayAutoSupersede({ type: 'DECISION', confidence: 0.9, evidence: 'explicit' })).toBe(true);
    expect(mayAutoSupersede({ type: 'DECISION', confidence: 0.9, evidence: 'inferred' })).toBe(false);
    expect(mayAutoSupersede({ type: 'DECISION', confidence: 0.1, evidence: 'explicit' })).toBe(false);
  });
});

describe('evidence grading', () => {
  it('grades an outright declaration as explicit', () => {
    for (const sentence of [
      '배포 방식은 Docker로 결정했다.',
      '배포 방식은 Kubernetes로 변경하기로 결정했다.',
      '인증은 JWT로 하기로 했다.',
      '리포트 포맷은 JSON으로 확정했다.',
      'We decided to use PostgreSQL.'
    ]) {
      expect(classifyMessage(sentence).evidence, sentence).toBe('explicit');
    }
  });

  it('grades a sentence that only implies an outcome as inferred', () => {
    // Each of these still classifies as DECISION — the point is that it is not
    // allowed to become a standing fact on its own.
    for (const [sentence, label] of [
      ['확정', 'ko:확정-결정-종결'],
      ['Database is PostgreSQL', 'en:copula-decision'],
      ['We will use Docker', 'en:will-use']
    ] as const) {
      const result = classifyMessage(sentence);
      expect(result.type, sentence).toBe('DECISION');
      expect(result.matched, sentence).toBe(label);
      expect(result.evidence, sentence).toBe('inferred');
    }
  });

  it('grades nothing when nothing fired', () => {
    expect(gradeEvidence(null)).toBeNull();
    expect(classifyMessage('음 그렇구나').evidence).toBeNull();
  });

  it('carries the grade onto every extracted candidate', () => {
    const [explicit] = extractCandidates(conversation(['배포 방식은 Docker로 결정했다.']));
    expect(explicit?.type).toBe('DECISION');
    expect(explicit?.evidence).toBe('explicit');
    expect(initialStatus({ type: explicit!.type, confidence: explicit!.confidence, evidence: explicit!.evidence })).toBe('active');

    const [inferredDecision] = extractCandidates(conversation(['Database is PostgreSQL']));
    expect(inferredDecision?.type).toBe('DECISION');
    expect(inferredDecision?.evidence).toBe('inferred');
    expect(initialStatus({ type: inferredDecision!.type, confidence: inferredDecision!.confidence, evidence: inferredDecision!.evidence })).toBe('candidate');
  });

  it('grades an unclassified message as inferred, so prose never promotes itself', () => {
    const long = '이것은 그냥 일상적인 대화 기록입니다 아무 결정도 아니고 작업도 아닙니다 그냥 흘러가는 이야기일 뿐입니다.';
    const [candidate] = extractCandidates(conversation([long]));
    expect(candidate?.evidence).toBe('inferred');
  });
});
