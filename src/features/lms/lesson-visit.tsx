'use client';

import { useEffect, useRef } from 'react';
import { recordLessonVisit } from '@/server/lms/actions';

/** Фиксирует открытие урока после монтирования (prefetch страницы не считается посещением). */
export function LessonVisit({ lessonId }: { lessonId: string }) {
  const sent = useRef(false);
  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    void recordLessonVisit(lessonId);
  }, [lessonId]);
  return null;
}
