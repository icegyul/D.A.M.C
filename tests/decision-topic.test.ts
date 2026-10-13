import { describe, expect, it } from 'vitest';
import { extractDecisionSubject, linkDecisionSubjects, decidesDifferently } from '../src/services/decision-topic.js';

/** Mirrors the gate memory-engine applies before it runs the semantic-overlap check. */
function wouldConsiderConflict(previous: string, next: string): boolean {
  const a = extractDecisionSubject(previous);
  const b = extractDecisionSubject(next);
  const link = linkDecisionSubjects(a, b);
  if (!link.linked) return false;
  return decidesDifferently(a, b) !== false;
}

describe('subject extraction', () => {
  it('separates the subject from the chosen value', () => {
    const s = extractDecisionSubject('배포 방식은 Docker로 결정했다.');
    expect(s.topicTokens).toEqual(['배포', '방식']);
    expect(s.valueTokens).toContain('docker');
    expect(s.hasChangeMarker).toBe(false);
  });

  it('keeps the subject stable when the value changes', () => {
    const a = extractDecisionSubject('배포 방식은 Docker로 결정했다.');
    const b = extractDecisionSubject('배포 방식은 Kubernetes로 변경하기로 결정했다.');
    expect(b.topicTokens).toEqual(a.topicTokens);
    expect(b.valueTokens).not.toEqual(a.valueTokens);
    expect(b.hasChangeMarker).toBe(true);
  });

  it('drops leading adverbs from the subject', () => {
    expect(extractDecisionSubject('앞으로 배포는 Kubernetes로 진행하기로 결정했다.').topicTokens).toEqual(['배포']);
  });

  it('falls back to the verb noun when no subject particle is present', () => {
    expect(extractDecisionSubject('앞으로 Kubernetes 기반으로 배포하기로 결정했다.').topicTokens).toEqual(['배포']);
  });

  it('records the value being moved away from', () => {
    const s = extractDecisionSubject('데이터베이스를 PostgreSQL에서 MySQL로 변경하기로 했다.');
    expect(s.priorValueTokens).toContain('postgresql');
    expect(s.valueTokens).toContain('mysql');
    expect(s.hasChangeMarker).toBe(true);
  });

  it('does not treat decision markers as the subject', () => {
    const s = extractDecisionSubject('배포 방식은 Docker로 결정했다.');
    expect(s.topicTokens).not.toContain('결정');
    expect(s.valueTokens).not.toContain('결정');
  });
});

describe('same subject — conflict is considered', () => {
  const cases: Array<[string, string]> = [
    ['배포 방식은 Docker로 결정했다.', '배포 방식은 Kubernetes로 변경하기로 결정했다.'],
    ['데이터베이스는 PostgreSQL로 결정했다.', '데이터베이스는 MySQL로 변경하기로 결정했다.'],
    ['배포 방식은 Docker로 결정했다.', '배포는 Kubernetes로 하기로 했다.'],
    ['배포는 Docker로 가기로 했다.', '앞으로 Kubernetes 기반으로 배포하기로 결정했다.'],
    ['배포 방식은 Docker로 결정했다.', '배포 방식은 이제 Kubernetes로 확정했다.'],
    ['데이터 저장소는 PostgreSQL로 확정했다.', '데이터베이스를 PostgreSQL에서 MySQL로 변경하기로 했다.']
  ];
  for (const [previous, next] of cases) {
    it(`links "${previous}" -> "${next}"`, () => {
      expect(wouldConsiderConflict(previous, next)).toBe(true);
    });
  }
});

describe('different subject — decisions stay independent', () => {
  const cases: Array<[string, string]> = [
    // Same leading noun, different aspect of it.
    ['배포 방식은 Docker로 결정했다.', '배포 일정은 9월 20일로 결정했다.'],
    // Shares the word PostgreSQL, but one decides the database and the other a backup policy.
    ['데이터베이스는 PostgreSQL로 결정했다.', 'PostgreSQL 백업 정책은 매일 수행하기로 결정했다.'],
    // Unrelated subjects entirely.
    ['배포 방식은 Docker로 결정했다.', '데이터베이스는 PostgreSQL로 결정했다.'],
    ['로그 보관 기간은 30일로 결정했다.', '배포 방식은 Docker로 결정했다.']
  ];
  for (const [previous, next] of cases) {
    it(`keeps "${previous}" and "${next}" independent`, () => {
      expect(wouldConsiderConflict(previous, next)).toBe(false);
    });
  }

  // A single shared generic noun must never be sufficient on its own.
  it('does not link on one shared generic noun', () => {
    expect(wouldConsiderConflict('배포 방식은 Docker로 결정했다.', '배포 일정은 9월 20일로 결정했다.')).toBe(false);
    expect(wouldConsiderConflict('시스템 언어는 한국어로 결정했다.', '시스템 폰트는 Pretendard로 결정했다.')).toBe(false);
  });

  // Korean qualifies subjects with generic classifier nouns, so matching on the head
  // noun alone made "인증 방식" supersede "배포 방식". Both share 방식 and nothing else.
  it('does not link two subjects that only share a generic classifier head', () => {
    expect(wouldConsiderConflict('배포 방식은 Kubernetes로 결정했다.', '인증 방식은 세션으로 결정했다.')).toBe(false);
    expect(wouldConsiderConflict('알림 방식은 이메일로 결정했다.', '결제 방식은 카드로 결정했다.')).toBe(false);
  });
});

describe('same subject and same value is not a conflict', () => {
  it('reports no change when the decided value is identical', () => {
    const a = extractDecisionSubject('배포 방식은 Docker로 결정했다.');
    const b = extractDecisionSubject('배포는 Docker로 가기로 했다.');
    expect(linkDecisionSubjects(a, b).linked).toBe(true);
    expect(decidesDifferently(a, b)).toBe(false);
    expect(wouldConsiderConflict('배포 방식은 Docker로 결정했다.', '배포는 Docker로 가기로 했다.')).toBe(false);
  });

  it('reports a change when the decided value differs', () => {
    const a = extractDecisionSubject('배포 방식은 Docker로 결정했다.');
    const b = extractDecisionSubject('배포 방식은 Kubernetes로 결정했다.');
    expect(decidesDifferently(a, b)).toBe(true);
  });

  it('returns null when no value can be compared', () => {
    const a = extractDecisionSubject('배포 방식은 결정했다.');
    const b = extractDecisionSubject('배포 방식은 결정했다.');
    expect(decidesDifferently(a, b)).toBeNull();
  });
});

describe('revision evidence', () => {
  it('links through an explicit value transition even when wording differs', () => {
    const a = extractDecisionSubject('데이터 저장소는 PostgreSQL로 확정했다.');
    const b = extractDecisionSubject('데이터베이스를 PostgreSQL에서 MySQL로 변경하기로 했다.');
    expect(linkDecisionSubjects(a, b)).toEqual({ linked: true, reason: 'revision' });
  });

  it('does not link on a mentioned value without a change marker', () => {
    const a = extractDecisionSubject('데이터베이스는 PostgreSQL로 결정했다.');
    const b = extractDecisionSubject('PostgreSQL 백업 정책은 매일 수행하기로 결정했다.');
    expect(linkDecisionSubjects(a, b).linked).toBe(false);
  });
});
