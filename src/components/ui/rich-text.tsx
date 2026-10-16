import type { ReactNode } from 'react';

/**
 * Безопасный вывод текстов страниц и документов из БД. HTML не интерпретируется
 * (никакого dangerouslySetInnerHTML): поддерживается минимальная разметка —
 *   «## » / «### » в начале строки — заголовки,
 *   «- » — пункты списка,
 *   пустая строка — новый абзац.
 * Заголовки начинаются со уровня h2: h1 страницы задаёт PageHeader.
 */
export function RichText({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let paragraph: string[] = [];
  let list: string[] = [];

  const flush = () => {
    if (paragraph.length) {
      blocks.push(<p key={`p${blocks.length}`}>{paragraph.join(' ')}</p>);
      paragraph = [];
    }
    if (list.length) {
      blocks.push(
        <ul key={`l${blocks.length}`} className="list-disc space-y-1 pl-6">
          {list.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>,
      );
      list = [];
    }
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') {
      flush();
    } else if (line.startsWith('### ')) {
      flush();
      blocks.push(
        <h3 key={`h${blocks.length}`} className="pt-2 text-lg font-semibold">
          {line.slice(4)}
        </h3>,
      );
    } else if (line.startsWith('## ')) {
      flush();
      blocks.push(
        <h2 key={`h${blocks.length}`} className="pt-4 text-xl font-semibold">
          {line.slice(3)}
        </h2>,
      );
    } else if (line.startsWith('- ')) {
      if (paragraph.length) flush();
      list.push(line.slice(2));
    } else {
      if (list.length) flush();
      paragraph.push(line);
    }
  }
  flush();
  return <div className="max-w-prose space-y-4">{blocks}</div>;
}
