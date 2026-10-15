/** Эталонный словарь: форма `ru` задаёт тип Dictionary для остальных языков. */
export const ru = {
  meta: {
    title: 'Okuspace — языковая школа',
    description: 'Платформа для обучения, расписания и управления филиалами языковой школы.',
  },
  common: {
    skipToContent: 'Перейти к содержимому',
  },
  languageSwitcher: {
    label: 'Язык интерфейса',
  },
  home: {
    status: 'Платформа в разработке',
    heading: 'Okuspace',
    description: 'Единая платформа для обучения, расписания и управления филиалами языковой школы.',
  },
  notFound: {
    heading: 'Страница не найдена',
  },
};

export type Dictionary = typeof ru;
