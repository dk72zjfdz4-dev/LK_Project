import PDFDocument from 'pdfkit';
import { fileURLToPath } from 'node:url';

const font = fileURLToPath(new URL('./assets/NotoSans-Regular.ttf', import.meta.url));
const dateFormat = new Intl.DateTimeFormat('ru-RU', {
  dateStyle: 'long',
  timeZone: 'Europe/Moscow',
});
const notice = 'Демонстрационный документ. Не является официальной справкой';

function certificateFields({ id, fullName, date }) {
  return [
    ['Владелец', fullName],
    ['Номер демонстрационной заявки', String(id)],
    ['Дата готовности', dateFormat.format(new Date(date))],
  ];
}

export function escapeHtml(value) {
  const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return value.replace(/[&<>"']/g, (character) => entities[character]);
}

export function certificatePrint(data) {
  const fields = certificateFields(data).map(([label, value]) => (
    '<div><dt>' + label + '</dt><dd>' + escapeHtml(value) + '</dd></div>'
  )).join('');
  return printableDocument('Демонстрационная справка', `<p class="notice">${notice}</p>
    <h1>${escapeHtml(data.type)}</h1>
    <dl>${fields}</dl>`);
}

export function printableDocument(title, markup) {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="/certificate-print.css">
  <script src="/certificate-print.js" defer></script>
</head>
<body>
  <main>
    ${markup}
  </main>
</body>
</html>`;
}

export function certificatePdf(data) {
  return documentPdf('Демонстрационная справка', (doc) => {
    doc.fillColor('#101828').fontSize(15).text(notice, { lineGap: 4 });
    doc.moveDown(1.8).fontSize(25).text(data.type, { lineGap: 4 });
    doc.moveDown(1.5);
    for (const [label, value] of certificateFields(data)) {
      doc.fillColor('#344054').fontSize(11).text(label);
      doc.fillColor('#101828').fontSize(15).text(value, { lineGap: 4 });
      doc.moveDown(0.9);
    }
  });
}

export function documentPdf(title, draw) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 56,
      info: { Title: title, Creator: 'Конкурсный прототип' },
    });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.once('end', () => resolve(Buffer.concat(chunks)));
    doc.once('error', reject);
    doc.rect(0, 0, doc.page.width, doc.page.height).fill('#fff');
    doc.font(font).fillColor('#101828');
    draw(doc);
    doc.end();
  });
}
