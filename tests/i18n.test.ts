import { describe, expect, it, beforeEach } from 'vitest';
import {
  DICTIONARIES, LANGUAGES, DEFAULT_LANGUAGE,
  detectLanguage, isSupported, setLanguage, getLanguage, translate, t
} from '../web/i18n.js';

const languageIds = LANGUAGES.map(l => l.id);

beforeEach(() => { setLanguage(DEFAULT_LANGUAGE); });

describe('language catalogue', () => {
  it('offers English and Korean', () => {
    expect(languageIds).toEqual(['en', 'ko']);
    expect(LANGUAGES.find(l => l.id === 'ko')?.label).toBe('한국어');
  });

  it('has a dictionary for every offered language', () => {
    for (const id of languageIds) {
      expect(Object.keys(DICTIONARIES[id] ?? {}).length, id).toBeGreaterThan(100);
    }
  });
});

/**
 * The failure this guards against is a half-translated screen: a key added to
 * one language and forgotten in the other silently falls back to English.
 */
describe('dictionaries stay in sync', () => {
  it('defines exactly the same keys in every language', () => {
    const en = Object.keys(DICTIONARIES.en).sort();
    for (const id of languageIds) {
      const other = Object.keys(DICTIONARIES[id]).sort();
      const missing = en.filter(k => !other.includes(k));
      const extra = other.filter(k => !en.includes(k));
      expect(missing, `${id} is missing keys`).toEqual([]);
      expect(extra, `${id} has keys English does not`).toEqual([]);
    }
  });

  it('never leaves a translation empty', () => {
    for (const id of languageIds) {
      for (const [key, value] of Object.entries(DICTIONARIES[id])) {
        expect(typeof value, `${id}.${key}`).toBe('string');
        expect((value as string).trim().length, `${id}.${key} is empty`).toBeGreaterThan(0);
      }
    }
  });

  it('keeps the same placeholders in every language', () => {
    const placeholders = (s: string) => (s.match(/\{(\w+)\}/g) ?? []).sort();
    for (const [key, english] of Object.entries(DICTIONARIES.en)) {
      for (const id of languageIds.filter(l => l !== 'en')) {
        expect(placeholders(DICTIONARIES[id][key] as string), `${id}.${key} placeholders`)
          .toEqual(placeholders(english as string));
      }
    }
  });

  // Korean should actually be Korean; a copied English string is a missed translation.
  it('actually translates the Korean dictionary', () => {
    const identical = Object.keys(DICTIONARIES.en).filter(k => DICTIONARIES.ko[k] === DICTIONARIES.en[k]);
    // Only values that are the same word in both languages may match: the product
    // wordmark, the MCP acronym, and Obsidian — a product name that is not
    // translated, exactly like the other two.
    expect(identical.sort()).toEqual(['brand.sub', 'channel.mcp', 'nav.obsidian', 'obsidian.title', 'page.obsidian.title']);
  });
});

describe('lookup', () => {
  it('returns the string for the active language', () => {
    setLanguage('en');
    expect(t('nav.memory')).toBe('Memory');
    setLanguage('ko');
    expect(t('nav.memory')).toBe('메모리');
  });

  it('interpolates named parameters', () => {
    setLanguage('en');
    expect(t('memory.countMany', { n: 12 })).toBe('12 memories');
    setLanguage('ko');
    expect(t('memory.countMany', { n: 12 })).toBe('12개 메모리');
  });

  it('leaves an unknown placeholder untouched rather than printing undefined', () => {
    expect(translate('en', 'memory.countMany', {})).toBe('{n} memories');
  });

  it('falls back to English, then to the key itself', () => {
    expect(translate('ko', 'nav.memory')).toBe('메모리');
    expect(translate('xx' as string, 'nav.memory')).toBe('Memory');
    expect(translate('en', 'no.such.key')).toBe('no.such.key');
  });

  it('ignores an unsupported language instead of breaking', () => {
    setLanguage('klingon');
    expect(getLanguage()).toBe(DEFAULT_LANGUAGE);
    expect(t('nav.memory')).toBe('Memory');
  });
});

describe('language detection', () => {
  it('picks Korean for Korean browsers', () => {
    for (const tag of ['ko', 'ko-KR', 'KO-kr']) expect(detectLanguage(tag), tag).toBe('ko');
  });

  it('defaults to English otherwise', () => {
    for (const tag of ['en-US', 'ja', 'fr', '', undefined, null]) {
      expect(detectLanguage(tag as string), String(tag)).toBe('en');
    }
  });

  it('reports which languages are supported', () => {
    expect(isSupported('ko')).toBe(true);
    expect(isSupported('en')).toBe(true);
    expect(isSupported('de')).toBe(false);
    expect(isSupported('')).toBe(false);
  });
});
