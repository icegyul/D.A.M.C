import { describe, expect, it } from 'vitest';
import { extractDecisionSubject, linkDecisionSubjects, decidesDifferently } from '../src/services/decision-topic.js';

/** Mirrors the family gate memory-engine applies before creating a supersession. */
function family(previous: string, next: string): 'supersede' | 'independent' {
  const a = extractDecisionSubject(previous);
  const b = extractDecisionSubject(next);
  if (!linkDecisionSubjects(a, b).linked) return 'independent';
  return decidesDifferently(a, b) === false ? 'independent' : 'supersede';
}

const subjectOf = (text: string) => extractDecisionSubject(text);

describe('dimension extraction', () => {
  it('separates the subject from the aspect being decided', () => {
    const s = subjectOf('배포 방식은 Docker로 결정했다.');
    expect(s.subjectTokens).toEqual(['배포']);
    expect(s.dimension).toBe('method');
    expect(s.valueType).toBe('choice');
  });

  it('reads a schedule decision on the same subject', () => {
    const s = subjectOf('배포 일정은 9월 20일로 결정했다.');
    expect(s.subjectTokens).toEqual(['배포']);
    expect(s.dimension).toBe('schedule');
    expect(s.valueType).toBe('date');
  });

  it('leaves the dimension unknown when no classifier noun is present', () => {
    const s = subjectOf('배포는 Docker로 결정했다.');
    expect(s.subjectTokens).toEqual(['배포']);
    expect(s.dimension).toBe('unknown');
  });

  it('keeps a qualified subject out of the dimension', () => {
    const s = subjectOf('PostgreSQL 백업 정책은 매일 수행하기로 결정했다.');
    expect(s.subjectTokens).toEqual(['postgresql', '백업']);
    expect(s.dimension).toBe('policy');
  });

  it('normalizes method wording onto one dimension', () => {
    for (const text of ['배포 방식은 Docker로 결정했다.', '배포 방법은 Docker로 결정했다.', '배포 수단은 Docker로 결정했다.']) {
      expect(subjectOf(text).dimension, text).toBe('method');
    }
  });

  it('normalizes schedule wording onto one dimension', () => {
    for (const text of ['배포 일정은 9월 20일로 결정했다.', '배포 날짜는 9월 20일로 결정했다.', '배포 시점은 9월 20일로 결정했다.']) {
      expect(subjectOf(text).dimension, text).toBe('schedule');
    }
  });

  it('does not force an unrecognised word into a dimension', () => {
    expect(subjectOf('데이터베이스는 PostgreSQL로 결정했다.').dimension).toBe('unknown');
  });
});

describe('value type detection', () => {
  const cases: Array<[string, string]> = [
    ['배포 일정은 9월 20일로 결정했다.', 'date'],
    ['배포 날짜를 10월 1일로 변경하기로 했다.', 'date'],
    ['인증 만료 시간은 30분으로 결정했다.', 'duration'],
    ['백업 주기는 매일 수행하기로 결정했다.', 'frequency'],
    ['서버 개수는 3대로 결정했다.', 'choice'],
    ['월 예산은 500만원으로 결정했다.', 'quantity'],
    ['배포 방식은 Docker로 결정했다.', 'choice'],
    ['인증 방식은 세션으로 결정했다.', 'choice']
  ];
  for (const [text, expected] of cases) {
    it(`reads ${expected} from "${text}"`, () => {
      expect(subjectOf(text).valueType).toBe(expected);
    });
  }

  // A date and a technology are both strings; they are not the same kind of answer.
  it('does not collapse different value shapes into one type', () => {
    expect(subjectOf('배포 일정은 9월 20일로 결정했다.').valueType)
      .not.toBe(subjectOf('배포 방식은 Docker로 결정했다.').valueType);
  });
});

describe('same family — supersedes', () => {
  const cases: Array<[string, string, string]> = [
    ['배포 방식은 Docker로 결정했다.', '배포 방식은 Kubernetes로 변경하기로 결정했다.', 'Docker -> Kubernetes'],
    ['데이터베이스는 PostgreSQL로 결정했다.', '데이터베이스는 MySQL로 변경하기로 했다.', 'PostgreSQL -> MySQL'],
    ['인증 방식은 세션으로 결정했다.', '인증 방식은 JWT로 변경하기로 했다.', 'session -> JWT'],
    ['배포 일정은 9월 20일로 결정했다.', '배포 날짜를 10월 1일로 변경하기로 했다.', 'schedule moved'],
    ['배포 방식은 Docker로 결정했다.', '배포 방법은 Kubernetes로 하기로 했다.', 'method wording differs'],
    ['캐시 저장소는 Redis로 확정했다.', '캐시를 Redis에서 Memcached로 변경하기로 했다.', 'revision evidence'],
    // A later statement may drop the dimension and rely on the established context.
    ['인증 방식은 세션으로 결정했다.', '앞으로 인증은 JWT 기반으로 처리하기로 했다.', 'dimension elided in the newer statement']
  ];
  for (const [previous, next, label] of cases) {
    it(`supersedes: ${label}`, () => {
      expect(family(previous, next)).toBe('supersede');
    });
  }
});

describe('different family — never supersedes', () => {
  const cases: Array<[string, string, string]> = [
    ['배포 방식은 Docker로 결정했다.', '배포 일정은 9월 20일로 결정했다.', 'method vs schedule'],
    ['배포 방식은 Docker로 결정했다.', '배포 정책은 매주 금요일 점검한다.', 'method vs policy'],
    ['데이터베이스는 PostgreSQL로 결정했다.', 'PostgreSQL 백업 정책은 매일 수행하기로 결정했다.', 'engine vs backup policy'],
    ['인증 방식은 JWT로 결정했다.', '인증 만료 시간은 30분으로 결정했다.', 'method vs expiry time'],
    ['배포 방식은 Docker로 결정했다.', '데이터베이스는 PostgreSQL로 결정했다.', 'unrelated subjects'],
    ['배포 일정은 9월 20일로 결정했다.', '배포 방식은 Kubernetes로 결정했다.', 'schedule vs method, reversed'],
    ['인증 방식은 세션으로 결정했다.', '배포 방식은 Docker로 결정했다.', 'same dimension, different subject']
  ];
  for (const [previous, next, label] of cases) {
    it(`independent: ${label}`, () => {
      expect(family(previous, next)).toBe('independent');
    });
  }
});

describe('unknown dimension is uncertain, not a wildcard', () => {
  // A bare earlier decision must not be assumed to have been about the aspect a
  // later, more specific statement happens to name.
  it('does not let a later method decision supersede an earlier bare one', () => {
    expect(family('배포는 Docker로 결정했다.', '배포 방식은 Kubernetes로 변경했다.')).toBe('independent');
  });

  it('does not let a later schedule decision supersede an earlier bare one', () => {
    expect(family('배포는 Docker로 결정했다.', '배포 일정은 9월 20일로 결정했다.')).toBe('independent');
  });

  it('still links two bare decisions on the same subject', () => {
    expect(family('데이터베이스는 PostgreSQL로 결정했다.', '데이터베이스는 MySQL로 변경하기로 했다.')).toBe('supersede');
  });

  it('blocks two bare decisions whose values are different kinds of thing', () => {
    expect(family('배포는 Docker로 결정했다.', '배포는 9월 20일로 결정했다.')).toBe('independent');
  });
});

describe('value comparison still gates the supersession', () => {
  it('restating the same value is not a conflict', () => {
    expect(family('배포 방식은 Docker로 결정했다.', '배포 방법은 Docker로 하기로 했다.')).toBe('independent');
  });

  it('a changed value on the same family is a conflict', () => {
    const a = subjectOf('배포 방식은 Docker로 결정했다.');
    const b = subjectOf('배포 방식은 Kubernetes로 결정했다.');
    expect(decidesDifferently(a, b)).toBe(true);
  });
});

describe('dimension mismatch outranks surface similarity', () => {
  // These two sentences are nearly identical as text; only the dimension differs.
  // No amount of token overlap may join them.
  it('refuses to link near-identical sentences from different dimensions', () => {
    const previous = '배포 방식은 Docker로 결정했다.';
    const next = '배포 일정은 Docker 출시일로 결정했다.';
    expect(linkDecisionSubjects(subjectOf(previous), subjectOf(next)).linked).toBe(false);
  });
});
