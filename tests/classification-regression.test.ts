import { describe, expect, it } from 'vitest';
import { classifyMessage } from '../src/services/text-classification.js';
import { extractCandidates } from '../src/services/ingestion-service.js';
import type { ConversationInput } from '../src/types/domain.js';

function conversation(messages: string[]): ConversationInput {
  return {
    provider: 'test',
    externalId: 'classification-regression',
    title: '회귀 테스트',
    messages: messages.map((content, i) => ({ role: 'user' as const, content, sequenceNo: i }))
  };
}

const typesFor = (text: string) => extractCandidates(conversation([text])).map(c => c.type);

/**
 * Short-message behaviour. The 30-character floor used to discard every short
 * Korean directive before classification ran; messages carrying an explicit
 * signal now survive it, while short small talk must still be dropped.
 */
describe('short message regression', () => {
  it('keeps a short Korean decision', () => {
    expect(classifyMessage('이걸로 결정했어').type).toBe('DECISION');
    expect(typesFor('이걸로 결정했어')).toEqual(['DECISION']);
  });

  it('keeps a short Korean task', () => {
    expect(classifyMessage('이거 해줘').type).toBe('TASK');
    expect(typesFor('이거 해줘')).toEqual(['TASK']);
  });

  // 확정 / 결정 / 해줘 standing alone are treated as directives on purpose: as a whole
  // message they are a confirmation or an instruction, and both are required keywords.
  // Their descriptive uses are handled by the veto rules, covered below.
  it('treats a bare confirmation token as a decision', () => {
    expect(classifyMessage('확정').type).toBe('DECISION');
    expect(classifyMessage('결정').type).toBe('DECISION');
  });

  it('treats a bare imperative as a task', () => {
    expect(classifyMessage('해줘').type).toBe('TASK');
  });

  // A bare noun with no particle and no verb is not a directive.
  it('does not classify a bare topic noun', () => {
    expect(classifyMessage('작업').type).toBeNull();
  });

  it('preserves English short-form behaviour', () => {
    expect(classifyMessage('we decided this').type).toBe('DECISION');
    expect(typesFor('we decided this')).toEqual(['DECISION']);
  });

  it('produces no candidate for short small talk', () => {
    for (const filler of ['그래', '응', '알겠어', 'ㅇㅋ', '네', '음 그렇구나']) {
      expect(classifyMessage(filler).type, filler).toBeNull();
      expect(extractCandidates(conversation([filler])), filler).toHaveLength(0);
    }
  });
});

/**
 * False positives. These sentences contain 결정 / 작업 / 확정 / 진행 but none of them
 * states a decision or asks for work, so no DECISION or TASK candidate may appear.
 * Asserted through extractCandidates, not the matcher alone.
 */
describe('false positive regression', () => {
  const cases = [
    '결정이라는 단어의 뜻을 설명해줘',
    '결정할 필요가 있다',
    '이걸 할까?',
    '좋을 것 같다',
    '어제 작업을 끝냈다',
    '작업이라는 단어는 무슨 뜻이야'
  ];

  for (const text of cases) {
    it(`never yields DECISION or TASK for "${text}"`, () => {
      expect(classifyMessage(text).type).toBeNull();
      expect(typesFor(text).filter(t => t === 'DECISION' || t === 'TASK')).toEqual([]);
    });
  }

  it('keeps longer descriptive prose out of DECISION/TASK', () => {
    const longer = [
      '이 방향이 맞는지 결정할 필요가 있다. 아직 논의가 더 필요하다.',
      '확정이라는 표현은 계약서에서 특별한 의미를 가진다고 알고 있다.',
      '이 기능을 진행하는 방법은 다음과 같다. 우선 문서를 읽고 구조를 파악한다.'
    ];
    for (const text of longer) {
      const types = typesFor(text);
      expect(types.length, text).toBe(1);
      expect(types.filter(t => t === 'DECISION' || t === 'TASK'), text).toEqual([]);
    }
  });
});

/**
 * The scoring the promotion layer keys on. memory-engine promotes DECISION to
 * active and leaves everything else as a candidate, so the type and importance
 * emitted here are the contract that behaviour depends on.
 */
describe('candidate contract used by promotion', () => {
  it('emits DECISION at importance 0.9 so it is promoted to active', () => {
    const [candidate] = extractCandidates(conversation(['배포 방식은 Docker로 결정했다.']));
    expect(candidate?.type).toBe('DECISION');
    expect(candidate?.importance).toBe(0.9);
    expect(candidate?.confidence).toBe(0.55);
  });

  it('emits TASK at importance 0.75 so it stays a candidate', () => {
    const [candidate] = extractCandidates(conversation(['내일까지 PostgreSQL 복구 테스트를 추가해야 해.']));
    expect(candidate?.type).toBe('TASK');
    expect(candidate?.importance).toBe(0.75);
  });

  it('gives an identical decision an identical title and content, so dedup can match it', () => {
    const first = extractCandidates(conversation(['배포 방식은 Docker로 결정했다.']))[0];
    const second = extractCandidates(conversation(['배포 방식은 Docker로 결정했다.']))[0];
    expect(second?.title).toBe(first?.title);
    expect(second?.content).toBe(first?.content);
    expect(second?.type).toBe(first?.type);
  });
});
