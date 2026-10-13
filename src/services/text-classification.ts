/**
 * Decision / task detection for ingested conversation messages.
 *
 * This is the detection layer only. It decides *whether* a message states a
 * settled decision or an actionable task; the candidate shape, scoring and the
 * candidate -> active promotion in memory-engine are unchanged.
 *
 * Why it exists: the previous inline heuristic wrapped Korean alternatives in
 * JavaScript word boundaries. `\b` is defined over [A-Za-z0-9_], so it never
 * matches between two Hangul syllables and every Korean decision or task fell
 * through to KNOWLEDGE/HISTORY. Simply deleting `\b` would match substrings
 * ("predecision"), so ASCII terms keep their boundaries and Korean is matched
 * through explicit inflected forms and phrases instead.
 *
 * Detection runs per sentence so that one hedged or interrogative clause does
 * not suppress a genuine directive elsewhere in the same message, and so that a
 * question mark only vetoes the clause it belongs to.
 */

export type ClassifiedType = 'DECISION' | 'TASK' | null;

/**
 * How firmly the sentence settles the matter, as opposed to how confident the
 * detector is that it fired correctly.
 *
 * `explicit` — the sentence names the act: "…로 결정했다", "…하기로 했다",
 * "decided to use …". Someone stated an outcome.
 * `inferred`  — the type was reached by implication: a bare "확정" fragment with
 * no subject or value, "will use X", or the copula pattern
 * ("Database is PostgreSQL"). These are usually right and still
 * worth recording, but nobody actually declared a decision.
 *
 * The promotion gate consumes this: only explicit evidence may enter shared
 * memory as a standing fact. See services/promotion-gate.ts.
 */
export type EvidenceStrength = 'explicit' | 'inferred';

export interface Classification {
  type: ClassifiedType;
  /** The pattern that fired, kept for provenance so a classification is explainable. */
  matched: string | null;
  /** Graded from `matched`; `null` when nothing fired. */
  evidence: EvidenceStrength | null;
}

/**
 * Decision labels that settle a matter only by implication. Everything else in
 * DECISION_KO/DECISION_EN names the decision act outright and counts as
 * explicit. Listing the weak side (rather than the strong one) keeps a newly
 * added pattern from silently gaining promotion rights — a new label is graded
 * explicit only because someone wrote it into the strong list by not adding it
 * here, which is reviewed with the pattern itself.
 */
const INFERRED_DECISION_LABELS = new Set([
  // A whole sentence that is just "확정" or "결정": no subject, no chosen value.
  'ko:확정-결정-종결',
  // "수정했다" is far more often a code edit than a settled decision.
  'ko:수정',
  // Intent and narration of a change, not a declared decision.
  'en:will-use',
  'en:changed-to',
  'en:switched-to',
  // Narrow, but still an inference from sentence shape: "Database is PostgreSQL".
  'en:copula-decision'
]);

export function gradeEvidence(matched: string | null): EvidenceStrength | null {
  if (!matched) return null;
  return INFERRED_DECISION_LABELS.has(matched) ? 'inferred' : 'explicit';
}

/** Split on sentence terminators and newlines, keeping the terminator with its sentence. */
function toSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?。！？])\s+|\n+/u)
    .map(s => s.trim())
    .filter(Boolean);
}

// --------------------------------------------------------------------------
// Vetoes. A sentence matching any of these never yields DECISION or TASK,
// however many keywords it also contains.
// --------------------------------------------------------------------------

/** "결정이라는 단어의 뜻", "결정 피로란 무엇인가?" — the word is the subject, not an act. */
const META_DEFINITION = /(이?라는 (단어|말|용어|개념)|란 (무엇|뭐)|이란 (무엇|뭐)|무슨 뜻|뜻이 (뭐|무엇)|뜻을 (설명|알려)|의미(가 뭐|는 무엇|를 설명)|무엇인가|무엇입니까|정의(가|는) 뭐|what does .{0,24} mean|definition of)/iu;

/** Interrogatives. "이걸 할까?", "A로 하는 게 어떨까?" */
const QUESTION = /([?？]\s*$)|(을까|ㄹ까|까요|어떨까|어떨지|어때요?|는 게 어때|하는 게 어떨)/u;

/** Hedges and opinions. "A로 하면 좋을 것 같다", "생각해보자" */
const HYPOTHETICAL = /(것 같|것같|듯하|듯 하|면 좋겠|으면 좋|좋을 것|좋을듯|나을 것|생각해\s?보|고민(이|해|중)|아마도?\s|maybe|probably|i think|might be|would be better|perhaps)/iu;

/** Pending deliberation — a decision still owed is not a decision taken. */
const UNRESOLVED = /(결정할 필요|결정이 필요|결정을 (내려야|해야 할)|정할 필요|아직 (결정|확정)(되지|하지|이 안)|검토 (중|해야)|논의(가 필요|해야| 중)|미정|보류)/u;

/**
 * Capability, requirement, or intent. Saying a change *could*, *should* or *will*
 * happen settles nothing, so these never count as a decision even though they use
 * the same change verbs: "변경할 수 있다", "변경이 필요하다", "변경될 예정이다".
 */
const NOT_SETTLED = /(할 수 있|될 수 있|수도 있|할 수도|필요하다|필요가 있|필요합니다|예정이|예정입니다|계획이다|계획입니다|계획 중|하려고|하려 한다|하면 된다|권장|추천)/u;

/** Past narration. "어제 A를 했다" is history, not an outstanding task. */
const PAST_NARRATION = /(어제|그저께|지난\s?(주|달|번)|저번|예전에|이미|앞서)[^.!?]*?(했다|했어|했습니다|헀다|끝냈|완료(했|됐|되었)|마쳤)/u;

/** English past narration — "We used Docker yesterday" settles nothing outstanding. Task branch only, like the Korean guard. */
const PAST_NARRATION_EN = /\b(yesterday|last\s+(night|week|month|year)|ago)\b/i;

// --------------------------------------------------------------------------
// DECISION signals
// --------------------------------------------------------------------------

const DECISION_KO: Array<[RegExp, string]> = [
  [/결정했|결정한다|결정합니다|결정하자|결정됐|결정된|결정되었|결정이다|결정입니다/u, 'ko:결정-inflected'],
  [/(으)?로 결정|(이|가)? ?최종 결정|최종적으로 결정/u, 'ko:로-결정'],
  [/확정했|확정한다|확정됐|확정된|확정되었|확정입니다|(으)?로 확정|안으로 확정/u, 'ko:확정'],
  [/정했다|정했어|정했습니다|(으)?로 정했|정하기로/u, 'ko:정했'],
  [/하기로 했|하기로 한다|하기로 하자|하기로 결정|기로 확정/u, 'ko:하기로-했'],
  [/진행하기로|사용하기로|운영하기로|유지하기로|도입하기로/u, 'ko:동사-하기로'],
  [/(으)?로 간다|(으)?로 가기로|(으)?로 밀고|방식으로 간다/u, 'ko:로-간다'],
  // Explicit change declarations. Announcing that something *was* changed settles
  // the matter just as much as announcing that it was decided, and these are the
  // sentences a revision is most often written as.
  [/변경했|변경한다|변경합니다|변경됐|변경된|변경되었|변경하기로/u, 'ko:변경'],
  [/바꿨|바꿉니다|바꾸기로|바꾼다/u, 'ko:바꿈'],
  [/교체했|교체한다|교체하기로|교체됐/u, 'ko:교체'],
  [/전환했|전환한다|전환하기로|전환됐/u, 'ko:전환'],
  [/수정했다|수정한다|수정하기로/u, 'ko:수정'],
  [/확정$|결정$/u, 'ko:확정-결정-종결']
];

/** ASCII keeps word boundaries so "predecision" and "finality" do not match. */
const DECISION_EN: Array<[RegExp, string]> = [
  [/\b(decision|decided|final|lock(?:ed)?)\b/iu, 'en:decision'],
  // Settled-choice phrasings. Each names an answer, not an option being weighed
  // (questions and hedges are vetoed above before any of these run).
  [/\bwas\s+decided\s+as\b/i, 'en:was-decided-as'],
  [/\bdecided\s+to\s+use\b/i, 'en:decided-to-use'],
  [/\bwill\s+use\b/i, 'en:will-use'],
  [/\bchanged?\s+to\b/i, 'en:changed-to'],
  [/\bswitched?\s+(\w+\s+)?to\b/i, 'en:switched-to'],
  // Copula with a capitalized answer on a known aspect: "Database is PostgreSQL".
  // Deliberately narrow — the aspect noun and the capital keep "The sky is blue"
  // and "Docker is popular" out. Subject matches both casings; the value must
  // start uppercase, so the pattern stays case-sensitive on purpose (no /i).
  [/\b([Mm]ethod|[Dd]atabase|[Aa]uthentication|[Dd]eployment|[Bb]ackup|[Ss]erver|[Ss]chedule|[Pp]olicy|[Ff]ramework|[Pp]latform|[Tt]ool|[Ss]tack|[Ll]anguage)\b[^.!?]{0,40}?\bis\s+[A-Z][A-Za-z0-9_+#.-]*/, 'en:copula-decision']
];

// --------------------------------------------------------------------------
// TASK signals
// --------------------------------------------------------------------------

const TASK_KO: Array<[RegExp, string]> = [
  [/해야\s?(한다|합니다|해|함|됩니다|된다|겠|지)/u, 'ko:해야'],
  [/(진행|처리|수정|확인|추가|삭제|구현|배포|검증|정리|작성|테스트)해야/u, 'ko:동사-해야'],
  [/(만들|고치|바꾸|옮기)어야|만들어야|고쳐야|바꿔야/u, 'ko:만들어야'],
  [/해\s?줘|해주세요|해주십시오|해 주라|부탁(해|드려|드립니다)/u, 'ko:해줘'],
  [/(만들어|수정해|확인해|처리해|추가해|삭제해|구현해|정리해|작성해|배포해|검증해)(\s?줘|주세요|라|$|[.!])/u, 'ko:동사-명령'],
  [/다음 (작업|단계|할 일|스텝)|할 일|해야 할 (일|것)|todo/iu, 'ko:다음-작업'],
  [/(을|를)? ?처리할 것|할 것$|해둘 것|진행할 것/u, 'ko:할-것'],
  [/진행하자|진행한다|진행합니다|작업하자|작업을 하자|시작하자/u, 'ko:진행하자'],
  [/작업(을|은|이|하| 목록)/u, 'ko:작업']
];

const TASK_EN: Array<[RegExp, string]> = [
  [/\b(todo|next|task|tasks|implement)\b/iu, 'en:task'],
  // Sentence-initial imperatives: "Implement the API gateway." Past-tense forms
  // ("Implemented…", "Checked… yesterday") do not match the base form.
  [/^\s*(please\s+)?(implement|add|update|check|create|fix|remove|delete|migrate|deploy|configure|refactor|write|review|verify)\b/i, 'en:imperative']
];

function firstMatch(sentence: string, patterns: Array<[RegExp, string]>): string | null {
  for (const [pattern, label] of patterns) {
    if (pattern.test(sentence)) return label;
  }
  return null;
}

const NOTHING: Classification = { type: null, matched: null, evidence: null };

function classifySentence(sentence: string): Classification {
  if (META_DEFINITION.test(sentence)) return NOTHING;
  if (QUESTION.test(sentence)) return NOTHING;
  if (HYPOTHETICAL.test(sentence)) return NOTHING;

  if (!UNRESOLVED.test(sentence) && !NOT_SETTLED.test(sentence)) {
    const decision = firstMatch(sentence, DECISION_KO) ?? firstMatch(sentence, DECISION_EN);
    if (decision) return { type: 'DECISION', matched: decision, evidence: gradeEvidence(decision) };
  }

  if (!PAST_NARRATION.test(sentence) && !PAST_NARRATION_EN.test(sentence)) {
    const task = firstMatch(sentence, TASK_KO) ?? firstMatch(sentence, TASK_EN);
    if (task) return { type: 'TASK', matched: task, evidence: gradeEvidence(task) };
  }

  return NOTHING;
}

/**
 * Classify a whole message. A DECISION anywhere in the message wins over a TASK,
 * matching the precedence the previous inline heuristic used.
 */
export function classifyMessage(text: string): Classification {
  let task: Classification | null = null;
  for (const sentence of toSentences(text)) {
    const result = classifySentence(sentence);
    if (result.type === 'DECISION') return result;
    if (result.type === 'TASK' && !task) task = result;
  }
  return task ?? NOTHING;
}
