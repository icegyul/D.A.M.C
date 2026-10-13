import { describe, expect, it } from 'vitest';
import { classifyMessage } from '../src/services/text-classification.js';
import { extractCandidates } from '../src/services/ingestion-service.js';
import type { ConversationInput } from '../src/types/domain.js';

const typeOf = (text: string) => classifyMessage(text).type;

describe('A. Korean DECISION — positive', () => {
  const cases = [
    '이걸로 결정했어',
    '이 방향으로 하기로 했어',
    '이 방법으로 진행하기로 했다',
    '최종 결정은 A로 한다',
    'A안으로 확정',
    'A로 정했어',
    '앞으로 A 방식으로 간다',
    '이건 A로 결정',
    '이렇게 하기로 하자',
    '데이터베이스는 PostgreSQL로 확정했다',
    '이 프로젝트는 앞으로 Docker 기반으로 운영하기로 결정했어.',
    '배포 방식은 컨테이너로 정하기로'
  ];
  for (const text of cases) {
    it(`classifies "${text}" as DECISION`, () => {
      expect(typeOf(text)).toBe('DECISION');
    });
  }
});

describe('B. Korean TASK — positive', () => {
  const cases = [
    '이거 해줘',
    '다음 작업은 A야',
    'A 작업을 진행해야 해',
    '내일까지 A를 해야 한다',
    'A를 만들어줘',
    'A 파일을 수정해줘',
    '이 부분을 확인해줘',
    '다음 단계로 A를 진행한다',
    'A를 처리할 것',
    '오늘 A 작업을 하자',
    '내일까지 보고서를 만들어야 해',
    '다음 작업은 PostgreSQL 복구 로직 테스트를 추가하는 거야.'
  ];
  for (const text of cases) {
    it(`classifies "${text}" as TASK`, () => {
      expect(typeOf(text)).toBe('TASK');
    });
  }
});

describe('C. Korean negative — no decision or task', () => {
  const cases = [
    'A는 좋은 방법이다.',
    'A로 하는 게 어떨까?',
    'A로 하면 좋을 것 같다.',
    '어제 A를 했다.',
    'A를 진행하는 방법은 다음과 같다.',
    '이걸 할까?',
    'A가 좋은 것 같다',
    '이렇게 하는 게 좋을 것 같아. 다른 방법도 생각해보자.',
    '어제 작업을 이미 끝냈다.'
  ];
  for (const text of cases) {
    it(`leaves "${text}" unclassified`, () => {
      expect(typeOf(text)).toBeNull();
    });
  }
});

describe('C2. Semantic safety — the keyword is the subject, not an act', () => {
  const cases = [
    '결정이라는 단어의 뜻을 설명해줘',
    '결정 피로란 무엇인가?',
    '작업이라는 단어는 무슨 뜻이야?',
    '이렇게 하는 게 좋을 것 같다',
    '이걸 할까?',
    '결정할 필요가 있다'
  ];
  for (const text of cases) {
    it(`does not classify "${text}"`, () => {
      expect(typeOf(text)).toBeNull();
    });
  }
});

describe('D. English regression', () => {
  it('still detects an English decision', () => {
    expect(typeOf('We decided to keep the existing codebase.')).toBe('DECISION');
    expect(typeOf('This is the final architecture for v2.')).toBe('DECISION');
  });

  it('still detects an English task', () => {
    expect(typeOf('TODO: wire the retrieval endpoint.')).toBe('TASK');
    expect(typeOf('Please implement the export adapter.')).toBe('TASK');
  });

  // The boundary rule the previous heuristic relied on must survive: this is the
  // reason Korean cannot simply drop \b.
  it('does not match ASCII keywords inside a larger word', () => {
    expect(typeOf('The predecision phase was documented.')).toBeNull();
    expect(typeOf('Finality was never discussed here.')).toBeNull();
    expect(typeOf('We reviewed multitasking research.')).toBeNull();
  });

  it('does not treat an English question as a decision', () => {
    expect(typeOf('Should this be the final approach?')).toBeNull();
  });
});

describe('E. Mixed Korean / English', () => {
  it('detects a decision in a mixed sentence', () => {
    expect(typeOf('backend framework는 Fastify로 결정했다.')).toBe('DECISION');
  });

  it('detects a task in a mixed sentence', () => {
    expect(typeOf('PostgreSQL pool 재연결 로직을 확인해줘.')).toBe('TASK');
  });

  it('keeps a hedged mixed sentence unclassified', () => {
    expect(typeOf('Redis를 쓰면 좋을 것 같다.')).toBeNull();
  });

  it('lets a decision clause win over an unrelated hedged clause', () => {
    expect(typeOf('처음에는 고민했다. 결국 Docker로 결정했다.')).toBe('DECISION');
  });
});

describe('F. Punctuation and whitespace', () => {
  it('tolerates trailing and repeated whitespace', () => {
    expect(typeOf('   이걸로 결정했어   ')).toBe('DECISION');
    expect(typeOf('이거 해줘')).toBe('TASK');
  });

  it('tolerates newline separated sentences', () => {
    expect(typeOf('배경 설명이다.\n이 방향으로 하기로 했다.')).toBe('DECISION');
  });

  it('does not let a question mark elsewhere veto a real directive', () => {
    expect(typeOf('이게 맞을까? 일단 이 부분을 확인해줘.')).toBe('TASK');
  });

  it('handles an empty or symbol-only message', () => {
    expect(typeOf('')).toBeNull();
    expect(typeOf('...!?')).toBeNull();
  });
});

// --------------------------------------------------------------------------
// Real pipeline: input -> extractCandidates -> candidate objects.
// This runs the production candidate builder, not just the matcher, so the
// length floor, title/summary construction and scoring are all exercised.
// --------------------------------------------------------------------------

function conversation(messages: string[]): ConversationInput {
  return {
    provider: 'test',
    externalId: 'classification-pipeline',
    title: '분류 파이프라인 테스트',
    messages: messages.map((content, i) => ({ role: 'user' as const, content, sequenceNo: i }))
  };
}

describe('G. Ingestion pipeline produces candidates', () => {
  it('creates a DECISION candidate from a short Korean decision', () => {
    const candidates = extractCandidates(conversation(['이걸로 결정했어']));
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.type).toBe('DECISION');
    expect(candidates[0]?.importance).toBe(0.9);
    expect(candidates[0]?.content).toBe('이걸로 결정했어');
    expect(candidates[0]?.title.startsWith('DECISION: ')).toBe(true);
  });

  it('creates a TASK candidate from a short Korean directive', () => {
    const candidates = extractCandidates(conversation(['이거 해줘']));
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.type).toBe('TASK');
    expect(candidates[0]?.importance).toBe(0.75);
  });

  it('records which signal fired, so the classification is explainable', () => {
    const [candidate] = extractCandidates(conversation(['이 프로젝트는 앞으로 Docker 기반으로 운영하기로 결정했어.']));
    expect(candidate?.type).toBe('DECISION');
    expect(candidate?.metadata?.heuristic).toBe(true);
    expect(typeof candidate?.metadata?.signal).toBe('string');
  });

  it('still drops short small talk that carries no decision or task', () => {
    expect(extractCandidates(conversation(['음 그렇구나']))).toHaveLength(0);
    expect(extractCandidates(conversation(['이걸 할까?']))).toHaveLength(0);
  });

  // Unclassified prose keeps the pre-existing fallback rule untouched:
  // a recognised project name yields KNOWLEDGE, otherwise HISTORY.
  it('keeps long unclassified prose as HISTORY when no project is detected', () => {
    const long = '이 시스템은 provider에 종속되지 않는 장기 기억 계층이며 그 자체가 기준 저장소 역할을 한다.';
    const [candidate] = extractCandidates(conversation([long]));
    expect(candidate?.type).toBe('HISTORY');
    expect(candidate?.importance).toBe(0.55);
  });

  it('keeps long unclassified prose as KNOWLEDGE when a project is detected', () => {
    const long = 'DAMC는 provider에 종속되지 않는 장기 기억 계층이며 그 자체가 canonical source of truth 역할을 한다.';
    const [candidate] = extractCandidates(conversation([long]));
    expect(candidate?.type).toBe('KNOWLEDGE');
    expect(candidate?.projectHint).toBe('damc');
    expect(candidate?.importance).toBe(0.55);
  });

  it('separates decision, task and prose across one conversation', () => {
    const candidates = extractCandidates(conversation([
      '이 프로젝트는 앞으로 Docker 기반으로 운영하기로 결정했어.',
      '다음 작업은 PostgreSQL 복구 로직 테스트를 추가하는 거야.',
      '이렇게 하는 게 좋을 것 같아. 다른 방법도 생각해보자.'
    ]));
    expect(candidates.map(c => c.type)).toEqual(['DECISION', 'TASK', 'HISTORY']);
  });
});
