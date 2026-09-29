/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test'
import { detectLanguage, withLanguageNote, nextLangState, type LangState } from '../lib/language'

describe('detectLanguage', () => {
  test('script beats keywords: Devanagari is Hindi even with English words mixed in', () => {
    expect(detectLanguage('मेरा credit score kaisa hai')).toBe('hi')
  })

  test('Tamil and Telugu scripts', () => {
    expect(detectLanguage('என் கிரெடிட் ஸ்கோர்')).toBe('ta')
    expect(detectLanguage('నా క్రెడిట్ స్కోర్')).toBe('te')
  })

  test('romanised Hindi with two or more markers is hinglish', () => {
    expect(detectLanguage('mera credit score kaisa hai bhai?')).toBe('hinglish')
    expect(detectLanguage('mujhe naya card chahiye')).toBe('hinglish')
    expect(detectLanguage('EMI zyada ho gaya hai, kya karu?')).toBe('hinglish')
  })

  test('plain English stays en', () => {
    expect(detectLanguage('How can I improve my credit score?')).toBe('en')
    expect(detectLanguage('Which credit card would suit me right now?')).toBe('en')
  })

  test('ONE borrowed word does not flip an English message', () => {
    // The conservative half of the rule: a false positive would answer an English speaker in Hinglish,
    // which is worse than the status quo of answering a Hinglish speaker in English.
    expect(detectLanguage('thanks bhai')).toBe('en')
    expect(detectLanguage('what is the fee aur the waiver?')).toBe('en')
  })

  test('English words that contain Hinglish markers do not fire', () => {
    // Word boundaries: "card" contains "kar", "hair" contains "hai", "theek" vs "the".
    expect(detectLanguage('I want a card for my hair salon spend')).toBe('en')
    expect(detectLanguage('the card and the fee')).toBe('en')
  })

  test('repeated calls are stable, so the shared global regex carries no lastIndex between them', () => {
    // The marker regex is compiled once at module scope (PR #20 review: it was being rebuilt per request).
    // A /g/ regex keeps `lastIndex`, which is only safe because String.match resets it; .test()/.exec()
    // would alternate answers on identical input. This is the check for that.
    for (let i = 0; i < 5; i++) {
      expect(detectLanguage('mera credit score kaisa hai bhai?')).toBe('hinglish')
      expect(detectLanguage('what is the annual fee on this card')).toBe('en')
    }
  })
})

describe('withLanguageNote', () => {
  test('appends for a non-English language, leaves en untouched', () => {
    expect(withLanguageNote('BASE', 'en')).toBe('BASE')
    expect(withLanguageNote('BASE', undefined)).toBe('BASE')
    expect(withLanguageNote('BASE', 'hinglish')).toContain('code-switching')
    expect(withLanguageNote('BASE', 'hi')).toContain('Devanagari')
  })

  test('every note keeps the digits rule, since the persona cap is not restated', () => {
    for (const lang of ['hi', 'hinglish', 'ta', 'te'] as const) {
      expect(withLanguageNote('BASE', lang)).toContain('digits')
    }
  })
})

describe('nextLangState (2-vote debounce, right-card finding 3d)', () => {
  test('a new session seeds committed from the FIRST detected language', () => {
    // Defaulting to en made a user opening in Hindi wait two turns for a Hindi reply.
    expect(nextLangState(undefined, 'hi')).toEqual({ committed: 'hi', pendingLang: null })
  })

  test('one opposing turn is a pending vote only', () => {
    const s: LangState = { committed: 'en', pendingLang: null }
    expect(nextLangState(s, 'hinglish')).toEqual({ committed: 'en', pendingLang: 'hinglish' })
  })

  test('two consecutive opposing turns commit the switch', () => {
    const s = nextLangState({ committed: 'en', pendingLang: null }, 'hinglish')
    expect(nextLangState(s, 'hinglish')).toEqual({ committed: 'hinglish', pendingLang: null })
  })

  test('returning to the committed language clears the pending vote', () => {
    const s = nextLangState({ committed: 'en', pendingLang: null }, 'hinglish')
    expect(nextLangState(s, 'en')).toEqual({ committed: 'en', pendingLang: null })
  })

  test('the debounce is symmetric: leaving a committed non-English language also needs two votes', () => {
    const s: LangState = { committed: 'hinglish', pendingLang: null }
    const one = nextLangState(s, 'en')
    expect(one).toEqual({ committed: 'hinglish', pendingLang: 'en' })
    expect(nextLangState(one, 'en')).toEqual({ committed: 'en', pendingLang: null })
  })

  test('a different third language replaces the pending vote instead of accumulating', () => {
    const s = nextLangState({ committed: 'en', pendingLang: null }, 'hinglish')
    expect(nextLangState(s, 'hi')).toEqual({ committed: 'en', pendingLang: 'hi' })
  })
})
