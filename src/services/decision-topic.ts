/**
 * Subject extraction for decision-like memories (DECISION / RULE / CONSTRAINT).
 *
 * Conflict detection needs to answer "are these two statements about the same
 * thing?" separately from "did the answer change?". The previous pre-filter
 * conflated the two: it matched on the first 50 characters of the title, and a
 * title is "DECISION: " plus the beginning of the content — which contains the
 * chosen value. So the moment the value changed (Docker -> Kubernetes) the older
 * decision dropped out of the candidate set and the overlap test never ran.
 *
 * Here the subject (topic) and the answer (value) are pulled apart, so topic can
 * gate the comparison while value differences are what make it a conflict.
 *
 * Two independent kinds of evidence link a new statement to an older one:
 *   topic match  — the statements are about the same subject
 *   revision     — the new statement names the previously chosen value and marks
 *                  a change ("PostgreSQL에서 MySQL로 변경"), which is explicit
 *                  evidence even when the subject is worded differently
 *                  (데이터 저장소 vs 데이터베이스).
 */

/**
 * What kind of thing the decided value is. Two statements about the same subject
 * can still be unrelated decisions — a deployment *method* and a deployment *date*
 * are different families — so the value's shape is part of the identity.
 */
export type ValueType = 'date' | 'duration' | 'frequency' | 'quantity' | 'choice' | 'unknown';

export interface DecisionSubject {
  /** Raw subject phrase, mostly for logging and tests. */
  topic: string;
  /** Full subject phrase tokens, including the dimension word when present. */
  topicTokens: string[];
  /** The thing being decided about, with the dimension word removed: 배포 방식 -> 배포. */
  subjectTokens: string[];
  /** Which aspect of the subject is being decided: method, schedule, policy, … */
  dimension: string;
  /** The shape of the decided value. */
  valueType: ValueType;
  /** Tokens of the chosen value, e.g. the Docker in "배포 방식은 Docker로 결정했다". */
  valueTokens: string[];
  /** Values the statement moves away from, e.g. the PostgreSQL in "PostgreSQL에서 MySQL로". */
  priorValueTokens: string[];
  /** Whether the statement explicitly signals replacing an earlier choice. */
  hasChangeMarker: boolean;
}

/** Longest first, so "으로"/"에서" are stripped before "로"/"에". */
const PARTICLES = ['으로', '에서', '에게', '에는', '까지', '부터', '이나', '로', '은', '는', '이', '가', '을', '를', '의', '도', '만', '와', '과', '에'];

/** Openers that are not part of the subject. */
const LEADING_ADVERB = /^(앞으로|앞으론|이제|이젠|우선|일단|결국|최종적으로|향후|당분간|그래서|따라서)\s+/u;

/** Verbs and nouns that mark the act of deciding rather than its subject. */
// Words naming the act of deciding. Dimension words such as 방식/방법/일정 are
// deliberately absent: they name which aspect is being decided and are read as the
// dimension, so dropping them here would erase that distinction.
const DECISION_MARKERS = new Set([
  '결정', '결정했다', '확정', '확정했다', '정했다', '변경', '진행', '최종', '것', '거',
  '하기', '되기', '가기', '수행', '사용', '운영', '도입', '유지', '적용'
]);

/** Explicit replacement of an earlier choice. */
const CHANGE_MARKER = /(변경|바꾸|바꿔|교체|대체|전환|철회|취소|대신|갈아)/u;

/** "X에서 Y로" — the from-side of a transition. */
const TRANSITION = /([A-Za-z0-9가-힣._+-]{2,})에서\s+[A-Za-z0-9가-힣._+-]{2,}(?:으로|로)/gu;

/**
 * Korean names the aspect being decided with a trailing classifier noun:
 * "배포 방식" / "배포 일정" / "배포 정책". Normalizing those into dimensions is what
 * keeps a deployment method apart from a deployment date. The list is deliberately
 * partial — an unrecognised word simply leaves the dimension unknown, which is the
 * conservative branch, rather than being forced into a bucket.
 */
const DIMENSION_VOCAB: Record<string, string> = {
  방식: 'method', 방법: 'method', 수단: 'method', 형태: 'method',
  구조: 'architecture', 아키텍처: 'architecture',
  기술: 'technology', 기술스택: 'technology', 스택: 'technology',
  프레임워크: 'technology', 플랫폼: 'technology', 도구: 'technology',
  정책: 'policy', 운영정책: 'policy', 규칙: 'policy', 기준: 'policy',
  일정: 'schedule', 날짜: 'schedule', 시점: 'schedule', 기한: 'schedule', 마감: 'schedule',
  시간: 'time', 시각: 'time',
  주기: 'frequency', 빈도: 'frequency',
  대상: 'target', 범위: 'scope', 위치: 'location',
  담당자: 'owner', 역할: 'role',
  금액: 'amount', 가격: 'amount', 예산: 'amount', 비용: 'amount',
  개수: 'quantity', 수량: 'quantity'
};

const VALUE_TYPE_PATTERNS: Array<[RegExp, ValueType]> = [
  [/(매일|매주|매월|매년|매분기|주기적|정기적|하루에|한\s*달에|번씩)/u, 'frequency'],
  // The unit must end the value rather than continue into another noun, but a
  // Korean particle may follow it: "30분으로", "3시간 동안", "10개월".
  [/\d+\s*(분|초|시간|주일|개월|일간|년간)(?=\s|$|[.,)]|으로|로|에|까지|부터|동안|간)/u, 'duration'],
  [/\d+\s*(원|만원|억|개|명|건|회|퍼센트|%|gb|mb|기가|메가)/iu, 'quantity'],
  [/(\d{4}\s*[-.년]|\d{1,2}\s*월|\d{1,2}\s*일(?![간정])|\d{4}-\d{2}-\d{2}|[월화수목금토일]요일|내일|모레|오늘)/u, 'date']
];

/** A few frequent English value shapes, so EN+EN and EN+KR pairs compare kinds, not just strings. */
const VALUE_TYPE_PATTERNS_EN: Array<[RegExp, ValueType]> = [
  [/\b(daily|weekly|monthly|yearly|every\s+(day|week|month|night|sunday|monday))\b/i, 'frequency'],
  [/\b\d+\s*(seconds?|minutes?|hours?|days?|weeks?|months?)\b/i, 'duration'],
  [/\b\d+\s*(usd|krw|dollars?|won|gb|mb|percent|%)\b/i, 'quantity'],
  [/\b(\d{4}-\d{2}-\d{2}|tomorrow|next\s+(week|monday|tuesday|wednesday|thursday|friday|sunday))\b/i, 'date']
];

function classifyValueType(valueRegion: string, valueTokens: string[]): ValueType {
  for (const [pattern, type] of VALUE_TYPE_PATTERNS) {
    if (pattern.test(valueRegion)) return type;
  }
  // A named option: Docker, Kubernetes, PostgreSQL, 세션, 카드 …
  return valueTokens.length ? 'choice' : 'unknown';
}

function stripParticle(token: string): string {
  for (const particle of PARTICLES) {
    // Never reduce a token below two characters.
    if (token.length >= particle.length + 2 && token.endsWith(particle)) {
      return token.slice(0, token.length - particle.length);
    }
  }
  return token;
}

function tokenize(phrase: string): string[] {
  return phrase
    .split(/[^A-Za-z0-9가-힣._+-]+/u)
    .map(t => t.replace(/^[._+-]+|[._+-]+$/gu, ''))
    .map(t => stripParticle(t).toLowerCase())
    .filter(t => t.length >= 2 && !DECISION_MARKERS.has(t));
}

function firstSentence(content: string): string {
  return (content.split(/(?<=[.!?。！？])\s+|\n+/u)[0] ?? content).trim();
}

export function extractDecisionSubject(content: string): DecisionSubject {
  const sentence = firstSentence(content).replace(LEADING_ADVERB, '');
  // English sentences take the English extractor below; anything with Hangul
  // (including mixed "배포 방식은 Docker로") keeps the Korean path byte-identical.
  if (!/[가-힣]/.test(sentence)) return extractDecisionSubjectEn(sentence);
  return extractDecisionSubjectKo(sentence);
}

function extractDecisionSubjectKo(content: string): DecisionSubject {
  const sentence = content;

  // Subject marked by a topic/object particle: "배포 방식은 …", "데이터베이스를 …".
  const marked = sentence.match(/^(.{2,40}?)(?:은|는|이|가|을|를)(?=\s)/u);
  let topic = marked?.[1]?.trim() ?? '';

  // Otherwise fall back to the noun the decision verb is built on:
  // "Kubernetes 기반으로 배포하기로 결정했다" -> 배포.
  if (!topic) {
    for (const m of sentence.matchAll(/([가-힣]{2,})(?:하기로|하기|한다|했다|하자)/gu)) {
      const candidate = m[1] ?? '';
      if (candidate && !DECISION_MARKERS.has(candidate)) { topic = candidate; break; }
    }
  }

  const topicTokens = [...new Set(tokenize(topic))];

  // Everything between the subject and the decision verb is where the answer sits.
  const afterTopic = marked ? sentence.slice(marked[0].length) : sentence;
  // The value ends where the decision verb begins. Change verbs terminate it too:
  // in "Docker로 변경했다" the answer is Docker, not "Docker 변경했다".
  const valueRegion = afterTopic
    .replace(/(결정|확정|정했|하기로|기로|변경|바꾸|바꿨|바꿉|교체|전환|수정)\s*(했|하|한|되|됐|이)?.*$/u, '')
    .trim();

  const priorValueTokens = [...new Set(
    [...sentence.matchAll(TRANSITION)].map(m => stripParticle(m[1] ?? '').toLowerCase()).filter(Boolean)
  )];

  const valueTokens = [...new Set(tokenize(valueRegion))]
    .filter(t => !topicTokens.includes(t) && !priorValueTokens.includes(t));

  // The trailing classifier noun names the aspect being decided, and is not part
  // of the thing itself: "배포 방식" is the method *of* 배포.
  const last = topicTokens[topicTokens.length - 1];
  const dimension = (last && DIMENSION_VOCAB[last]) || 'unknown';
  const subjectTokens = dimension !== 'unknown' && topicTokens.length > 1
    ? topicTokens.slice(0, -1)
    : topicTokens;

  return {
    topic,
    topicTokens,
    subjectTokens,
    dimension,
    valueType: classifyValueType(valueRegion, valueTokens),
    valueTokens,
    priorValueTokens,
    hasChangeMarker: CHANGE_MARKER.test(sentence)
  };
}

function isSubsetOf(small: string[], large: string[]): boolean {
  return small.length > 0 && small.every(t => large.includes(t));
}

export type SubjectLink = { linked: false } | { linked: true; reason: 'topic' | 'revision' };

/**
 * Decide whether `next` talks about the same subject as `previous`.
 *
 * Deliberately conservative: a single shared generic noun is not enough. Either
 * one subject must fully contain the other ("배포" vs "배포 방식"), or the head
 * nouns must agree, or the new statement must explicitly revise the old value.
 * That keeps "배포 방식" and "배포 일정" apart even though both mention 배포.
 */
/**
 * Do the two statements decide the same aspect of the same thing?
 *
 * A dimension mismatch is fatal regardless of how much text the two share: a
 * deployment method and a deployment date are different decisions even though both
 * say 배포. An unknown dimension is treated as uncertain rather than as a wildcard.
 */
function dimensionsCompatible(previous: DecisionSubject, next: DecisionSubject): boolean {
  if (previous.dimension === next.dimension) return true;
  // A later statement may drop the dimension and lean on the established context:
  // "인증 방식은 세션으로 결정했다" then "인증은 JWT로 하기로 했다".
  if (next.dimension === 'unknown') return true;
  // The reverse is not safe. An earlier bare "배포는 Docker로 결정했다" cannot be
  // assumed to have been about the method just because a later statement is.
  return false;
}

/**
 * Values must be the same kind of thing. This is what stops "배포는 Docker로" from
 * colliding with "배포 일정은 9월 20일로" when the dimension is unknown on one side.
 * When both dimensions are known and equal the dimension already establishes the
 * family, so an unreadable value type is tolerated there and only there.
 */
function valueTypesCompatible(previous: DecisionSubject, next: DecisionSubject): boolean {
  if (previous.dimension !== 'unknown' && previous.dimension === next.dimension) return true;
  if (previous.valueType === 'unknown' || next.valueType === 'unknown') return false;
  return previous.valueType === next.valueType;
}

export function linkDecisionSubjects(previous: DecisionSubject, next: DecisionSubject): SubjectLink {
  if (!dimensionsCompatible(previous, next)) return { linked: false };
  if (!valueTypesCompatible(previous, next)) return { linked: false };

  // Explicit revision: the new statement moves away from the value the old one chose.
  // This carries the subject evidence on its own, so differently worded subjects
  // ("데이터 저장소" / "데이터베이스") still link.
  if (next.hasChangeMarker && next.priorValueTokens.length && previous.valueTokens.length) {
    const prevValues = canonicalizeTokens(previous.valueTokens);
    const priors = canonicalizeTokens(next.priorValueTokens);
    const revisesPreviousValue = prevValues.some(v => priors.includes(v));
    if (revisesPreviousValue) return { linked: true, reason: 'revision' };
  }

  // Canonical forms so "배포" and "deployment" meet; unlisted words compare as
  // themselves, which keeps every existing same-language comparison identical.
  const a = canonicalizeTokens(previous.subjectTokens);
  const b = canonicalizeTokens(next.subjectTokens);
  if (!a.length || !b.length) return { linked: false };

  // Containment only, on the subject with the dimension word stripped off.
  //
  // Head-noun agreement is deliberately NOT used: Korean qualifies subjects with
  // generic classifier nouns, so "인증 방식" and "배포 방식" share the head 방식
  // while being entirely different decisions.
  if (isSubsetOf(a, b) || isSubsetOf(b, a)) return { linked: true, reason: 'topic' };

  return { linked: false };
}

/**
 * Whether the two statements actually settle on different answers. A restatement
 * of the same choice is not a conflict and must not supersede anything.
 * Returns null when neither side exposes a comparable value.
 */
export function decidesDifferently(previous: DecisionSubject, next: DecisionSubject): boolean | null {
  const prevValues = canonicalizeTokens(previous.valueTokens);
  const nextValues = canonicalizeTokens(next.valueTokens);
  if (!prevValues.length || !nextValues.length) return null;
  const shared = prevValues.filter(v => nextValues.includes(v));
  return shared.length !== prevValues.length || prevValues.length !== nextValues.length;
}

// ---------------------------------------------------------------------------
// English subject extraction + cross-language comparison.
// Same DecisionSubject shape and the same conservative linking — only the
// surface patterns differ. The Korean path above is untouched.
// ---------------------------------------------------------------------------

/** English aspect nouns, normalized to the same canonical dimensions Korean uses. */
const DIMENSION_VOCAB_EN: Record<string, string> = {
  method: 'method', approach: 'method', way: 'method', manner: 'method', mechanism: 'method', strategy: 'method',
  architecture: 'architecture',
  technology: 'technology', stack: 'technology', framework: 'technology', platform: 'technology', tool: 'technology',
  policy: 'policy', rule: 'policy', guideline: 'policy',
  schedule: 'schedule', date: 'schedule', deadline: 'schedule', timeline: 'schedule',
  time: 'time',
  frequency: 'frequency',
  target: 'target', scope: 'scope', location: 'location',
  owner: 'owner', role: 'role',
  amount: 'amount', price: 'amount', budget: 'amount', cost: 'amount',
  quantity: 'quantity'
};

/** Words that carry grammar, not meaning, in an English decision sentence. */
const EN_STOPWORDS = new Set([
  'the', 'a', 'an', 'our', 'their', 'my', 'we', 'i', 'you', 'they', 'he', 'she', 'it',
  'for', 'to', 'of', 'on', 'with', 'by', 'as', 'at', 'in', 'from',
  'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'will', 'would', 'shall', 'should', 'going',
  'use', 'using', 'used', 'decide', 'decided', 'deciding',
  'change', 'changed', 'changing', 'switch', 'switched', 'switching',
  'team', 'this', 'that', 'and', 'or'
]);

/** "Finally," / "Going forward," — not part of the subject. */
const LEADING_ADVERB_EN = /^(finally|going forward|from now on|for now|ultimately|in the end|so|therefore)\s*,?\s+/i;

const CHANGE_MARKER_EN = /\b(changed?\s+to|switch(?:ed|ing)?\s+to|migrat\w*\s+to|replac\w*\s+with|mov\w*\s+to|transition\w*\s+to|instead\s+of|revised?\s+to)\b/i;

/** "switched from X to Y" / "instead of X" — the value being moved away from. */
const TRANSITION_EN = /(?:from\s+([A-Za-z0-9_+#.-]{2,})\s+to|instead\s+of\s+([A-Za-z0-9_+#.-]{2,}))/gi;

const VALUE_WORD = '[A-Za-z0-9_+#.-]{2,}';

function tokenizeEn(phrase: string): string[] {
  return phrase
    .toLowerCase()
    .split(/[^a-z0-9_+#.-]+/i)
    .map(t => t.replace(/^[_.+#-]+|[_.+#-]+$/g, ''))
    .filter(t => t.length >= 2 && !EN_STOPWORDS.has(t));
}

function cleanSubjectEn(raw: string): string {
  return raw.replace(/^(the|our|a|an|this|that)\s+/i, '').replace(/[.?!]+$/, '').trim();
}

function classifyValueTypeEn(valueRegion: string, valueTokens: string[]): ValueType {
  for (const [pattern, type] of VALUE_TYPE_PATTERNS_EN) {
    if (pattern.test(valueRegion)) return type;
  }
  return valueTokens.length ? 'choice' : 'unknown';
}

function extractDecisionSubjectEn(sentence: string): DecisionSubject {
  const clean = sentence.replace(LEADING_ADVERB_EN, '').trim();
  let topic = '';
  let valueRegion = '';
  let m: RegExpMatchArray | null;

  // Most specific first: each names both the subject and the answer.
  if ((m = clean.match(new RegExp(`^(?:we|i|they|the team)\\s+(?:have\\s+|has\\s+)?decided\\s+to\\s+use\\s+(${VALUE_WORD})\\s+for\\s+(.+)$`, 'i')))) {
    valueRegion = m[1]!;
    topic = cleanSubjectEn(m[2]!);
  } else if ((m = clean.match(new RegExp(`^(.+?)\\s+(?:was|were|has been|have been)\\s+decided\\s+as\\s+(${VALUE_WORD})`, 'i')))) {
    topic = cleanSubjectEn(m[1]!);
    valueRegion = m[2]!;
  } else if ((m = clean.match(new RegExp(`^we\\s+switched\\s+(.+?)\\s+to\\s+(${VALUE_WORD})`, 'i')))) {
    topic = cleanSubjectEn(m[1]!);
    valueRegion = m[2]!;
  } else if ((m = clean.match(new RegExp(`^(.+?)\\s+changed?\\s+to\\s+(${VALUE_WORD})`, 'i')))) {
    topic = cleanSubjectEn(m[1]!);
    valueRegion = m[2]!;
  } else if ((m = clean.match(new RegExp(`^(.+?)\\s+will\\s+use\\s+(${VALUE_WORD})`, 'i')))) {
    topic = cleanSubjectEn(m[1]!);
    valueRegion = m[2]!;
  } else if ((m = clean.match(new RegExp(`^(.+?)\\s+uses?\\s+(${VALUE_WORD})`, 'i')))) {
    // "Acceptance cache uses Redis", "Auth uses JWT". Runs after the more
    // specific decided/will-use branches; the classifier gate keeps stray
    // "uses" sentences from ever reaching this extractor as decisions.
    topic = cleanSubjectEn(m[1]!);
    valueRegion = m[2]!;
  } else if ((m = clean.match(new RegExp(`^(.+?)\\s+(?:is|are)\\s+(${VALUE_WORD})`, 'i')))) {
    topic = cleanSubjectEn(m[1]!);
    valueRegion = m[2]!;
  } else {
    topic = cleanSubjectEn(clean);
  }

  const topicTokens = [...new Set(tokenizeEn(topic))];
  const valueTokens = [...new Set(tokenizeEn(valueRegion))].filter(t => !topicTokens.includes(t));
  const priorValueTokens = [...new Set(
    [...clean.matchAll(TRANSITION_EN)]
      .flatMap(x => [x[1], x[2]])
      .filter((x): x is string => !!x)
      .flatMap(x => tokenizeEn(x))
  )];

  const last = topicTokens[topicTokens.length - 1];
  const dimension = (last && DIMENSION_VOCAB_EN[last]) || 'unknown';
  const subjectTokens = dimension !== 'unknown' && topicTokens.length > 1
    ? topicTokens.slice(0, -1)
    : topicTokens;

  return {
    topic,
    topicTokens,
    subjectTokens,
    dimension,
    valueType: classifyValueTypeEn(valueRegion, valueTokens),
    valueTokens,
    priorValueTokens,
    hasChangeMarker: CHANGE_MARKER_EN.test(clean)
  };
}

/**
 * Subject synonym groups: the same thing said in Korean or English. A small
 * curated list of the nouns decisions are actually about — an unlisted word
 * compares as itself, which is the conservative branch.
 */
const SUBJECT_SYNONYM_GROUPS: Array<{ canon: string; aliases: string[] }> = [
  { canon: 'deploy', aliases: ['배포', 'deployment', 'deploy'] },
  { canon: 'auth', aliases: ['인증', 'authentication', 'auth'] },
  { canon: 'database', aliases: ['데이터베이스', '디비', 'database', 'db'] },
  { canon: 'backup', aliases: ['백업', 'backup'] },
  { canon: 'server', aliases: ['서버', 'server'] },
  { canon: 'schedule', aliases: ['일정', 'schedule'] },
  { canon: 'policy', aliases: ['정책', 'policy'] },
  { canon: 'payment', aliases: ['결제', 'payment'] },
  { canon: 'notification', aliases: ['알림', 'notification'] },
  { canon: 'logging', aliases: ['로깅', '로그', 'logging', 'log'] },
  { canon: 'test', aliases: ['테스트', 'test'] }
];

const ALIAS_TO_CANON = new Map<string, string>();
for (const group of SUBJECT_SYNONYM_GROUPS) {
  for (const alias of group.aliases) ALIAS_TO_CANON.set(alias.toLowerCase(), group.canon);
}

/** Map subject/value tokens to language-independent canonical forms. */
export function canonicalizeTokens(tokens: string[]): string[] {
  return tokens.map(t => ALIAS_TO_CANON.get(t.toLowerCase()) ?? t);
}

/**
 * SQL narrowing needles for the conflict lookup: raw tokens plus every
 * cross-language alias, so a Korean decision still finds an English row.
 */
export function expandNeedles(tokens: string[]): string[] {
  const out = new Set<string>();
  for (const token of tokens) {
    out.add(token);
    const canon = ALIAS_TO_CANON.get(token.toLowerCase());
    if (canon) {
      out.add(canon);
      for (const group of SUBJECT_SYNONYM_GROUPS) {
        if (group.canon === canon) for (const alias of group.aliases) out.add(alias);
      }
    }
  }
  return [...out];
}
