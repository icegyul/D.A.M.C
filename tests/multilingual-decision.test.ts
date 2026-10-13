/**
 * Multilingual memory semantics — the smallest suite that pins the fix.
 *
 *  1. Valid Korean / English / Japanese / emoji pass the Unicode gate unchanged.
 *  2. Lone surrogates are rejected (never stored, never echoed, server never crashes).
 *  3-5. English decisions expose subject / dimension / value like Korean ones do.
 *  6. Korean and English statements about the same decision link as one family.
 *  7. Same value restates; 8. changed value supersedes — across languages too.
 *  9-10. Questions and speculation are not decisions; 11. past facts aren't either.
 *  12. English imperatives are tasks.
 *
 * All hermetic: pure-function level. The live MCP round-trip (decision_create
 * KR→EN→SUPERSEDE) is verified against a running server, not faked here.
 */
import { describe, it, expect } from 'vitest';
import { safeText, hasInvalidUnicode } from '../src/lib/unicode-safety.js';
import { extractDecisionSubject, linkDecisionSubjects, decidesDifferently } from '../src/services/decision-topic.js';
import { classifyMessage } from '../src/services/text-classification.js';

describe('unicode gate', () => {
  it('passes Korean, English, Japanese and emoji through (NFC)', () => {
    expect(safeText('배포 방식은 Docker로 결정했다', 'content')).toBe('배포 방식은 Docker로 결정했다');
    expect(safeText('Deployment method is Docker.', 'content')).toBe('Deployment method is Docker.');
    expect(safeText('デプロイ方式はDockerに決定', 'content')).toBe('デプロイ方式はDockerに決定');
    expect(safeText('Ship it 🚀 done', 'content')).toBe('Ship it 🚀 done');
    // NFD jamo normalize to the composed syllable so hashing stays stable.
    expect(safeText('가', 'content')).toBe('가');
  });

  it('rejects lone surrogates without echoing the content', () => {
    expect(hasInvalidUnicode('A\ud800B')).toBe(true);
    expect(hasInvalidUnicode('A\udc00B')).toBe(true);
    expect(hasInvalidUnicode('valid')).toBe(false);
    // A well-formed surrogate pair (emoji) is not "invalid".
    expect(hasInvalidUnicode('🚀')).toBe(false);
    const payload = 'note ok \ud800 sk-proj-abcdefghijklmnopqrstuvwx';
    let message = '';
    try {
      safeText(payload, 'content');
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).toContain('content');
    expect(message).not.toContain('sk-proj');
    expect(message).not.toContain('note ok');
  });
});

describe('english decision extraction', () => {
  it('pulls subject / dimension / value apart ("Deployment method is Docker.")', () => {
    const s = extractDecisionSubject('Deployment method is Docker.');
    expect(s.dimension).toBe('method');
    expect(s.subjectTokens).toEqual(['deployment']);
    expect(s.valueTokens).toEqual(['docker']);
    expect(s.valueType).toBe('choice');
  });

  it.each([
    ['Deployment method was decided as Docker.', 'method', ['deployment'], ['docker']],
    ['We decided to use Docker for deployment.', 'unknown', ['deployment'], ['docker']],
    ['Deployment will use Docker.', 'unknown', ['deployment'], ['docker']],
    ['Deployment method changed to Kubernetes.', 'method', ['deployment'], ['kubernetes']],
    ['We switched deployment to Kubernetes.', 'unknown', ['deployment'], ['kubernetes']],
    ['Acceptance cache uses Redis.', 'unknown', ['acceptance', 'cache'], ['redis']],
    ['Authentication will use JWT.', 'unknown', ['authentication'], ['jwt']],
    ['Database is PostgreSQL.', 'unknown', ['database'], ['postgresql']]
  ])('extracts %s', (sentence, dimension, subject, value) => {
    const s = extractDecisionSubject(sentence);
    expect(s.dimension).toBe(dimension);
    expect(s.subjectTokens).toEqual(subject);
    expect(s.valueTokens).toEqual(value);
  });

  it('marks English change declarations', () => {
    expect(extractDecisionSubject('Deployment method changed to Kubernetes.').hasChangeMarker).toBe(true);
    expect(extractDecisionSubject('Deployment method is Docker.').hasChangeMarker).toBe(false);
  });
});

describe('cross-language family matching', () => {
  const krDocker = extractDecisionSubject('배포 방식은 Docker로 결정했다.');
  const enDocker = extractDecisionSubject('Deployment method is Docker.');
  const enK8s = extractDecisionSubject('Deployment method changed to Kubernetes.');

  it('links Korean and English statements about the same decision', () => {
    expect(linkDecisionSubjects(krDocker, enDocker)).toEqual({ linked: true, reason: 'topic' });
    expect(linkDecisionSubjects(krDocker, enK8s).linked).toBe(true);
  });

  it('restates the same value instead of conflicting', () => {
    expect(decidesDifferently(krDocker, enDocker)).toBe(false);
    expect(decidesDifferently(enDocker, extractDecisionSubject('Deployment method changed to Docker.'))).toBe(false);
  });

  it('supersedes on a changed value, within and across languages', () => {
    expect(decidesDifferently(krDocker, enK8s)).toBe(true);
    expect(decidesDifferently(enDocker, enK8s)).toBe(true);
  });

  it('links a plain "X uses Y" statement to a later change of the same subject', () => {
    const uses = extractDecisionSubject('Acceptance cache uses Redis.');
    const changed = extractDecisionSubject('Acceptance cache changed to Memcached.');
    expect(uses.valueTokens).toEqual(['redis']);
    expect(linkDecisionSubjects(uses, changed)).toEqual({ linked: true, reason: 'topic' });
    expect(decidesDifferently(uses, changed)).toBe(true);
  });

  it('keeps different aspects apart in English too', () => {
    const method = extractDecisionSubject('Deployment method is Docker.');
    const date = extractDecisionSubject('Deployment date was decided as Friday.');
    expect(linkDecisionSubjects(method, date).linked).toBe(false);
  });
});

describe('english classification guards', () => {
  it.each([
    'Deployment method is Docker.',
    'Deployment method was decided as Docker.',
    'We decided to use Docker for deployment.',
    'Deployment will use Docker.',
    'Deployment method changed to Kubernetes.',
    'We switched deployment to Kubernetes.',
    'Authentication will use JWT.',
    'Database is PostgreSQL.'
  ])('decides %s', (sentence) => {
    expect(classifyMessage(sentence).type).toBe('DECISION');
  });

  it.each([
    'Implement the API gateway.',
    'Add PostgreSQL recovery.',
    'Update the deployment configuration.',
    'Check the API gateway.'
  ])('tasks %s', (sentence) => {
    expect(classifyMessage(sentence).type).toBe('TASK');
  });

  it.each([
    'Should we use Docker?',
    'Maybe Docker would be better.',
    'I think Docker is better.',
    'We used Docker yesterday.'
  ])('does not decide %s', (sentence) => {
    expect(classifyMessage(sentence).type).not.toBe('DECISION');
  });
});
