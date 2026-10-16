/**
 * Тестовые примеры для проверки качества AI-отзывов о письме. Тексты вымышлены (без
 * персональных данных). mustFind — фрагменты с настоящими ошибками, которые отзыв обязан
 * найти (как «original» исправления, сравнение без регистра); clean-тексты ошибок не содержат.
 */
export interface WritingCase {
  id: string;
  targetLanguage: 'en' | 'ru';
  level: string;
  text: string;
  mustFind: string[];
}

export const WRITING_CASES: WritingCase[] = [
  {
    id: 'en-a2-past-simple',
    targetLanguage: 'en',
    level: 'A2',
    text: 'Last weekend I go to the mountains with my family. We buyed some food and we was very happy.',
    mustFind: ['go', 'buyed', 'was'],
  },
  {
    id: 'en-a2-third-person',
    targetLanguage: 'en',
    level: 'A2',
    text: 'My brother work in a bank. He don’t like his job, but he earn good money.',
    mustFind: ['work', 'don’t', 'earn'],
  },
  {
    id: 'en-b1-articles',
    targetLanguage: 'en',
    level: 'B1',
    text: 'I would like to become an engineer because engineer can change a world. I study at university in Bishkek.',
    mustFind: ['engineer can', 'a world'],
  },
  {
    id: 'en-b1-prepositions',
    targetLanguage: 'en',
    level: 'B1',
    text: 'I am interested on photography since three years. I usually take photos in the weekend.',
    mustFind: ['interested on', 'since three years', 'in the weekend'],
  },
  {
    id: 'en-a2-plural-spelling',
    targetLanguage: 'en',
    level: 'A2',
    text: 'There are many childs in our school. My freind has two cat.',
    mustFind: ['childs', 'freind', 'two cat'],
  },
  {
    id: 'en-b1-word-order',
    targetLanguage: 'en',
    level: 'B1',
    text: 'I like very much English music. Yesterday I have seen a great concert.',
    mustFind: ['like very much English music', 'have seen'],
  },
  {
    id: 'ru-a2-cases',
    targetLanguage: 'ru',
    level: 'A2',
    text: 'Я живу в Бишкек. Каждый день я хожу в университет с моя сестра.',
    mustFind: ['в Бишкек', 'с моя сестра'],
  },
  {
    id: 'ru-b1-aspect',
    targetLanguage: 'ru',
    level: 'B1',
    text: 'Вчера я читал книгу и наконец прочитывал её до конца. Мне очень понравилась эта книга.',
    mustFind: ['прочитывал'],
  },
  { id: 'en-clean-1', targetLanguage: 'en', level: 'B1', text: 'I have been learning English for two years. I enjoy reading short stories and watching films with subtitles.', mustFind: [] },
  { id: 'en-clean-2', targetLanguage: 'en', level: 'A2', text: 'On Saturdays I usually help my parents at home. In the evening we often play board games together.', mustFind: [] },
  { id: 'ru-clean-1', targetLanguage: 'ru', level: 'A2', text: 'Летом я люблю гулять в парке. Там много деревьев и всегда тихо.', mustFind: [] },
];

export interface CaseScore {
  id: string;
  found: string[];
  missed: string[];
  /** Исправления, не относящиеся к ожидаемым ошибкам (для чистых текстов — всё). */
  extra: number;
}

const norm = (s: string) => s.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();

/** Ожидаемая ошибка найдена, если её фрагмент совпадает с «original» исправления или входит в него (и наоборот). */
export function scoreCase(c: WritingCase, originals: string[]): CaseScore {
  const o = originals.map(norm);
  const hit = (frag: string) => o.some((x) => x.includes(norm(frag)) || norm(frag).includes(x));
  const found = c.mustFind.filter(hit);
  const extra = o.filter((x) => !c.mustFind.some((f) => x.includes(norm(f)) || norm(f).includes(x))).length;
  return { id: c.id, found, missed: c.mustFind.filter((f) => !hit(f)), extra };
}

export interface EvalSummary {
  recall: number;
  cleanFalsePositives: number;
  rejected: number;
  passed: boolean;
}

/** Порог качества: найдено ≥ 80% ошибок, на чистых текстах ≤ 1 лишнего исправления на текст, нет отбракованных ответов. */
export function summarize(scores: CaseScore[], rejected: number): EvalSummary {
  const expected = WRITING_CASES.reduce((n, c) => n + c.mustFind.length, 0);
  const found = scores.reduce((n, s) => n + s.found.length, 0);
  const clean = WRITING_CASES.filter((c) => c.mustFind.length === 0).map((c) => c.id);
  const worstClean = Math.max(0, ...scores.filter((s) => clean.includes(s.id)).map((s) => s.extra));
  const recall = expected ? found / expected : 1;
  return { recall, cleanFalsePositives: worstClean, rejected, passed: recall >= 0.8 && worstClean <= 1 && rejected === 0 };
}
