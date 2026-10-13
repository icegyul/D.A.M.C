import { describe, expect, it } from 'vitest';
import { classifyMessage } from '../src/services/text-classification.js';
import { extractCandidates } from '../src/services/ingestion-service.js';
import { extractDecisionSubject, linkDecisionSubjects, decidesDifferently } from '../src/services/decision-topic.js';
import type { ConversationInput } from '../src/types/domain.js';

const typeOf = (text: string) => classifyMessage(text).type;

function conversation(messages: string[]): ConversationInput {
  return {
    provider: 'test',
    externalId: 'change-declaration',
    title: '변경 선언 테스트',
    messages: messages.map((content, i) => ({ role: 'user' as const, content, sequenceNo: i }))
  };
}

function family(previous: string, next: string): 'supersede' | 'independent' {
  const a = extractDecisionSubject(previous);
  const b = extractDecisionSubject(next);
  if (!linkDecisionSubjects(a, b).linked) return 'independent';
  return decidesDifferently(a, b) === false ? 'independent' : 'supersede';
}

/**
 * A revision is most often written as "we changed X to Y", not "we decided X".
 * Those sentences previously carried no decision signal at all, so they never
 * reached classification and never reached supersedes matching either.
 */
describe('explicit change declarations are decisions', () => {
  const cases = [
    '배포 방식은 Kubernetes로 변경했다.',
    '배포 방식을 Kubernetes로 변경하기로 했다.',
    'DB를 PostgreSQL에서 MySQL로 바꿨다.',
    '캐시를 Redis로 바꾸기로 했다.',
    '인증 방식을 JWT로 교체했다.',
    '인증을 JWT로 교체하기로 했다.',
    '스토리지를 S3로 전환했다.',
    '로그 포맷을 JSON으로 전환하기로 했다.',
    '설정 파일을 수정했다.',
    '설정 파일을 수정하기로 했다.'
  ];
  for (const text of cases) {
    it(`classifies "${text}" as DECISION`, () => {
      expect(typeOf(text)).toBe('DECISION');
    });
  }
});

/** Possibility, requirement and intent settle nothing, even with the same verbs. */
describe('unsettled change talk is not a decision', () => {
  const cases = [
    '변경할 수 있다.',
    '변경이 필요하다.',
    '변경될 예정이다.',
    '배포 방식을 변경하려고 한다.',
    '변경을 권장한다.',
    '이 값은 나중에 바뀔 수도 있다.',
    '설정을 수정할 필요가 있다.'
  ];
  for (const text of cases) {
    it(`leaves "${text}" unclassified`, () => {
      expect(typeOf(text)).toBeNull();
    });
  }

  it('produces no DECISION candidate through the pipeline either', () => {
    for (const text of cases) {
      const types = extractCandidates(conversation([text])).map(c => c.type);
      expect(types.filter(t => t === 'DECISION'), text).toEqual([]);
    }
  });
});

describe('change declarations reach the candidate pipeline', () => {
  it('creates an active-bound DECISION candidate at decision importance', () => {
    const [candidate] = extractCandidates(conversation(['배포 방식은 Kubernetes로 변경했다.']));
    expect(candidate?.type).toBe('DECISION');
    expect(candidate?.importance).toBe(0.9);
    expect(candidate?.metadata?.signal).toBe('ko:변경');
  });

  it('separates a real change from talk about changing', () => {
    const types = extractCandidates(conversation([
      '배포 방식은 Kubernetes로 변경했다.',
      '변경이 필요하다.'
    ])).map(c => c.type);
    expect(types[0]).toBe('DECISION');
    expect(types[1]).not.toBe('DECISION');
  });
});

/** The new signal must feed the existing family rules, not bypass them. */
describe('change declarations respect dimension and value rules', () => {
  it('supersedes an earlier decision on the same subject and dimension', () => {
    expect(family('배포 방식은 Docker로 결정했다.', '배포 방식은 Kubernetes로 변경했다.')).toBe('supersede');
  });

  it('does not cross dimensions', () => {
    expect(family('배포 방식은 Docker로 결정했다.', '배포 일정을 10월 1일로 변경했다.')).toBe('independent');
  });

  it('does not cross subjects', () => {
    expect(family('배포 방식은 Docker로 결정했다.', '인증 방식을 JWT로 교체했다.')).toBe('independent');
  });

  it('still refuses to supersede when the value did not change', () => {
    expect(family('배포 방식은 Docker로 결정했다.', '배포 방식을 Docker로 변경했다.')).toBe('independent');
  });
});
