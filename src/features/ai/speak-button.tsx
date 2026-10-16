'use client';

import { useSyncExternalStore } from 'react';

/**
 * Озвучивание реплики собеседника синтезатором речи браузера. Используются только
 * локальные голоса (localService): сетевые голоса отправили бы текст стороннему сервису.
 * Нет подходящего голоса — кнопка не показывается.
 */
const hasSpeech = () => typeof window !== 'undefined' && 'speechSynthesis' in window;

function localVoice(lang: string): SpeechSynthesisVoice | undefined {
  if (!hasSpeech()) return undefined;
  return window.speechSynthesis.getVoices().find((v) => v.localService && v.lang.toLowerCase().startsWith(lang));
}

function subscribe(onChange: () => void) {
  if (!hasSpeech()) return () => {};
  window.speechSynthesis.addEventListener('voiceschanged', onChange);
  return () => window.speechSynthesis.removeEventListener('voiceschanged', onChange);
}

export function SpeakButton({ text, lang, label }: { text: string; lang: string; label: string }) {
  const voiceUri = useSyncExternalStore(
    subscribe,
    () => localVoice(lang)?.voiceURI ?? '',
    () => '',
  );
  if (!voiceUri) return null;
  return (
    <button
      type="button"
      className="mt-2 inline-flex min-h-11 items-center rounded-[var(--radius-control)] border border-border-strong px-3 text-sm hover:bg-surface-muted"
      onClick={() => {
        const voice = localVoice(lang);
        if (!voice) return;
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.voice = voice;
        u.lang = voice.lang;
        window.speechSynthesis.speak(u);
      }}
    >
      {label}
    </button>
  );
}
