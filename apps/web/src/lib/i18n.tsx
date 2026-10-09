/**
 * UI language support (tender Appendix 1 §45: multilingual user interface).
 *
 * Design: the English UI string is the translation key (`t('Sign in')`). Every visible string in the app is wrapped
 * in `t()` (see scripts/i18n/wrap-strings.mjs, which also extracts the key list to src/i18n/keys.json); the shared UI
 * primitives translate their own labels (DataTable headers, Field labels, Tabs, PageHeader, badges, toasts), so
 * callers can keep passing English. A missing translation falls back to English, never to a blank.
 *
 * The chosen language is stored per browser (localStorage `ksp.lang`), applied to <html lang>, and switching it
 * remounts the app tree so memoised strings re-evaluate. Server-generated text (API error messages, audit details,
 * data values) is not translated — only the interface chrome.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import kn from '@/i18n/kn.json';

export const LANGUAGES = [
  { code: 'en', label: 'English', nativeLabel: 'English', locale: 'en-IN' },
  { code: 'kn', label: 'Kannada', nativeLabel: 'ಕನ್ನಡ', locale: 'kn-IN' },
] as const;
export type Lang = (typeof LANGUAGES)[number]['code'];

const STORAGE_KEY = 'ksp.lang';
const dictionaries: Record<Lang, Record<string, string>> = { en: {}, kn: kn as Record<string, string> };

let currentLang: Lang = readStoredLang();
const listeners = new Set<() => void>();

function readStoredLang(): Lang {
  try {
    const fromUrl = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('lang') : null;
    const v = fromUrl ?? (typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null);
    return LANGUAGES.some((l) => l.code === v) ? (v as Lang) : 'en';
  } catch {
    return 'en';
  }
}

export function getLang(): Lang {
  return currentLang;
}

export function getLocale(): string {
  return LANGUAGES.find((l) => l.code === currentLang)?.locale ?? 'en-IN';
}

export function setLang(lang: Lang): void {
  if (lang === currentLang) return;
  currentLang = lang;
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    /* private mode */
  }
  applyDocumentLang();
  for (const fn of listeners) fn();
}

function applyDocumentLang(): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = currentLang;
  document.documentElement.dataset.lang = currentLang;
}

/**
 * Translate a UI string. `vars` fills `{name}` placeholders after translation, so word order can differ per language.
 * Unknown keys return the English text unchanged.
 */
export function t(key: string, vars?: Record<string, string | number | null | undefined>): string {
  const dict = dictionaries[currentLang];
  let out = (currentLang !== 'en' && dict[key]) || key;
  if (vars) for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(v == null ? '' : String(v));
  return out;
}

/** Translate only when the value is a plain string (ReactNode-typed props). */
export function tNode<T>(value: T): T | string {
  return typeof value === 'string' ? t(value) : value;
}

/** Translation coverage for the current language (for the admin "Languages" diagnostics). */
export function coverage(lang: Lang, keys: string[]): { translated: number; total: number } {
  const dict = dictionaries[lang];
  return { translated: lang === 'en' ? keys.length : keys.filter((k) => !!dict[k]).length, total: keys.length };
}

interface LanguageState {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: typeof t;
  locale: string;
}
const LanguageContext = createContext<LanguageState | null>(null);

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setState] = useState<Lang>(currentLang);
  useEffect(() => {
    applyDocumentLang();
    const fn = () => setState(currentLang);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);
  const change = useCallback((l: Lang) => setLang(l), []);
  const value = useMemo<LanguageState>(() => ({ lang, setLang: change, t, locale: getLocale() }), [lang, change]);
  // Remount everything below on language change so every t() (including memoised column/tab definitions) re-runs.
  return (
    <LanguageContext.Provider value={value}>
      <div key={lang} className="contents">
        {children}
      </div>
    </LanguageContext.Provider>
  );
}

export function useLang(): LanguageState {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error('useLang outside LanguageProvider');
  return ctx;
}

/** Compact language switcher (EN / ಕನ್ನಡ) for the header and the sign-in screens. */
export function LanguageSwitcher({ className = '' }: { className?: string }) {
  const { lang, setLang: change } = useLang();
  return (
    <div className={`inline-flex items-center rounded-md border border-ink-300 bg-white p-0.5 text-xs ${className}`} role="group" aria-label={t('Language')}>
      {LANGUAGES.map((l) => (
        <button
          key={l.code}
          type="button"
          lang={l.code}
          aria-pressed={lang === l.code}
          onClick={() => change(l.code)}
          className={`rounded px-2 py-1 font-medium ${lang === l.code ? 'bg-brand-700 text-white' : 'text-ink-700 hover:bg-ink-100'}`}
        >
          {l.nativeLabel}
        </button>
      ))}
    </div>
  );
}
