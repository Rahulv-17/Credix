/**
 * Language detection and per-language instruction notes.
 *
 * Ported from ../right-card (lib/language-notes.ts plus the decode stage of its proxy). Their finding
 * 3d is the reason this exists as a SHARED helper rather than living in one agent: originally only
 * their primary agent read the language signal, and the other three silently answered a Hindi user in
 * English. credix had no language handling at all before this.
 *
 * Detection is a pure function, no model call: script ranges are decisive, and Hinglish is a keyword
 * list because romanised Hindi shares the Latin alphabet with English. Deliberately cheap and
 * deliberately conservative — a missed Hinglish detection costs an English reply (today's behaviour),
 * while a false positive would answer an English speaker in Hinglish, which is worse.
 */

export type Language = 'en' | 'hi' | 'hinglish' | 'ta' | 'te'

const DEVANAGARI = /[ऀ-ॿ]/
const TAMIL = /[஀-௿]/
const TELUGU = /[ఀ-౿]/

// Romanised Hindi markers. Chosen to avoid English collisions: no "me", "to", "is", "hi". Each entry is
// matched on word boundaries, so "kar" does not fire on "card" and "hai" does not fire on "hair".
const HINGLISH_WORDS = [
  'kaisa', 'kaise', 'kaisi', 'kya', 'kyu', 'kyun', 'kyon', 'kitna', 'kitni', 'kaun', 'kaunsa', 'konsa',
  'mujhe', 'mera', 'meri', 'mere', 'aap', 'aapka', 'tum', 'hum', 'humko', 'mereko',
  // NOT in this list, learned from the unit tests: "the" (Hindi past-tense plural, and the most common
  // English word there is — it alone flipped "the card and the fee" to Hinglish), "rupees" (English),
  // "mil" (ambiguous). A marker that collides with ordinary English costs a wrong-language reply.
  'hai', 'hain', 'tha', 'thi', 'hoga', 'hogi', 'karu', 'karun', 'karna', 'karo', 'kare', 'karta',
  'chahiye', 'chahta', 'chahti', 'milega', 'milegi', 'lena', 'dena', 'batao', 'bata', 'bataye',
  'kharcha', 'kharch', 'paisa', 'paise', 'rupaye', 'bhai', 'yaar', 'accha', 'acha', 'theek',
  'zyada', 'kam', 'abhi', 'phir', 'lekin', 'aur', 'nahi', 'nahin', 'haan', 'sahi', 'galat', 'jyada',
  'bilkul', 'matlab', 'kuch', 'koi', 'sab', 'wala', 'wali', 'jaldi', 'thoda', 'bahut', 'bohot',
]
// Compiled once at module scope, not per call: detectLanguage runs on every request. Global flag because
// we need the COUNT of markers, not just a hit. Safe to reuse a /g/ regex here specifically because
// String.match resets lastIndex itself; .test() and .exec() would carry it between calls and alternate
// wrong answers on the same input.
const HINGLISH_RE = new RegExp(`\\b(${HINGLISH_WORDS.join('|')})\\b`, 'gi')

/**
 * Detect the language of one user message. Script beats keywords: a message in Devanagari is Hindi even
 * if it also contains English words. Two Hinglish markers are required, not one, because a single
 * borrowed word ("bhai", "aur") shows up in otherwise English messages.
 */
export function detectLanguage(text: string): Language {
  if (DEVANAGARI.test(text)) return 'hi'
  if (TAMIL.test(text)) return 'ta'
  if (TELUGU.test(text)) return 'te'
  const matches = text.match(HINGLISH_RE)
  return matches && matches.length >= 2 ? 'hinglish' : 'en'
}

/**
 * The note appended to an agent's instructions for a non-English user. Kept short on purpose: it rides
 * on every turn's prompt, and credix already runs large prompts. The persona rules (digits, no
 * dashes, word cap) still apply and are NOT restated here.
 */
export const LANGUAGE_NOTES: Record<Exclude<Language, 'en'>, string> = {
  hi: 'Language: the user is writing in Hindi. Reply entirely in Hindi (Devanagari script). Keep every number, rupee amount and percentage in digits exactly as the base rules require.',
  hinglish:
    'Language: the user is writing in Hinglish (romanised Hindi mixed with English). Match their code-switching register, casual and warm, and keep financial terms in English where that is how people actually say them. Keep every number in digits.',
  ta: 'Language: the user is writing in Tamil. Reply in Tamil. Keep every number in digits.',
  te: 'Language: the user is writing in Telugu. Reply in Telugu. Keep every number in digits.',
}

/** Append the matching language note to a base instruction string. `en` returns the base unchanged. */
export function withLanguageNote(base: string, language: unknown): string {
  const note = typeof language === 'string' && language !== 'en'
    ? LANGUAGE_NOTES[language as Exclude<Language, 'en'>]
    : undefined
  return note ? `${base}\n\n${note}` : base
}

/**
 * Committed-language state for one session, with right-card's symmetric 2-vote debounce: switching the
 * committed language, INTO or OUT OF English, needs two consecutive turns detecting the same alternate
 * language. One opposing turn is a pending vote only, and a return to the committed language clears it.
 * Their finding 3d: a brand-new thread seeds `committed` from the FIRST detected language, because
 * defaulting to English made a user who opened in Hindi wait two turns for a Hindi reply.
 */
export type LangState = { committed: Language; pendingLang: Language | null }

export function nextLangState(prev: LangState | undefined, detected: Language): LangState {
  if (!prev) return { committed: detected, pendingLang: null }
  if (detected === prev.committed) return { committed: prev.committed, pendingLang: null }
  if (detected === prev.pendingLang) return { committed: detected, pendingLang: null }
  return { committed: prev.committed, pendingLang: detected }
}
