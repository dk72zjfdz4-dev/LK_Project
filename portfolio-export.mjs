import { documentPdf, escapeHtml, printableDocument } from './certificate.mjs';

const notice = 'Конкурсный прототип. Демонстрационные данные';
const heading = 'Портфолио студента';
const categories = {
  study: 'Учёба', research: 'Исследования', projects: 'Проекты', olympiads: 'Олимпиады',
  volunteering: 'Волонтёрство', sports: 'Спорт', creativity: 'Творчество', internships: 'Стажировки',
};
const statuses = {
  draft: 'Черновик', pending: 'На проверке', confirmed: 'Подтверждено',
  clarification: 'Требуется уточнение', rejected: 'Не подтверждено',
};
const dateFormat = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'long', timeZone: 'Europe/Moscow' });

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? dateFormat.format(date) : '';
}

function exportSections({ achievements, recommendations }) {
  const sections = [];
  if (achievements.length) sections.push(['Достижения', achievements.map((item) => ({
    title: item.title,
    subtitle: [categories[item.category], formatDate(item.date), item.organizer].filter(Boolean).join(' · '),
    emphasis: 'Статус подтверждения: ' + (statuses[item.status] ?? 'Не подтверждено'),
    confirmation: item.status === 'confirmed' ? [item.reviewerName, formatDate(item.confirmedAt)].filter(Boolean).join(' · ') : '',
    text: item.description,
  }))]);
  if (recommendations.length) sections.push(['Рекомендации', recommendations.map((item) => ({
    title: item.goal,
    subtitle: [item.authorName, formatDate(item.publishedAt)].filter(Boolean).join(' · '),
    text: item.text,
  }))]);
  return sections;
}

export function portfolioPrint(data) {
  const sections = exportSections(data).map(([title, entries]) => `<section>
    <h2>${title}</h2>
    ${entries.map((item) => `<article>
      <h3>${escapeHtml(item.title)}</h3>
      <p>${escapeHtml(item.subtitle)}</p>
      ${item.emphasis ? `<p><strong>${escapeHtml(item.emphasis)}</strong></p>` : ''}
      ${item.confirmation ? `<p>${escapeHtml(item.confirmation)}</p>` : ''}
      <p>${escapeHtml(item.text ?? '').replaceAll('\n', '<br>')}</p>
    </article>`).join('')}
  </section>`).join('');
  return printableDocument(heading, `<p class="notice">${notice}</p>
    <h1>${heading}</h1><p>${escapeHtml(data.studentName)}</p>${sections}`);
}

export function portfolioPdf(data) {
  return documentPdf(heading, (doc) => {
    doc.fontSize(14).text(notice).moveDown();
    doc.fontSize(24).text(heading).moveDown(0.4);
    doc.fontSize(14).text(data.studentName).moveDown();
    for (const [title, entries] of exportSections(data)) {
      if (doc.y > doc.page.height - doc.page.margins.bottom - 100) doc.addPage();
      doc.fontSize(18).text(title).moveDown(0.45);
      for (const item of entries) {
        if (doc.y > doc.page.height - doc.page.margins.bottom - 78) doc.addPage();
        doc.fontSize(15).text(item.title);
        if (item.subtitle) doc.fontSize(11).text(item.subtitle);
        if (item.emphasis) doc.fontSize(12).text(item.emphasis);
        if (item.confirmation) doc.fontSize(11).text(item.confirmation);
        if (item.text) doc.fontSize(12).text(item.text, { lineGap: 3 });
        doc.moveDown(0.9);
      }
    }
  });
}
