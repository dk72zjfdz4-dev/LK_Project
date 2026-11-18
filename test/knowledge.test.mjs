import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answerFor, documents, faqFor } from '../knowledge.mjs';

test('each of the eight demonstration documents has its own form and only a type field', () => {
  assert.deepEqual(documents.map(({ title }) => title), [
    'Справка об обучении',
    'Справка о периоде обучения',
    'Справка об успеваемости',
    'Справка о размере стипендии',
    'Справка о неполучении стипендии',
    'Справка для предоставления по месту требования',
    'Запрос заверенной копии учебного плана',
    'Запрос заверенной выписки из приказа о зачислении',
  ]);
  assert.equal(new Set(documents.map(({ id }) => id)).size, 8);
  for (const { id, title, description, fields } of documents) {
    assert.ok(description);
    assert.deepEqual(fields.map(({ name }) => name), ['type']);
    const { answer, found } = answerFor('student', title);
    assert.equal(found, true);
    assert.equal(answer.title, title);
    assert.equal(answer.view, 'requests');
    assert.equal(answer.target, `document-${id}`);
  }
});

test('normalizes variants of Russian questions and chooses the matching answer and destination', () => {
  const cases = [
    ['  ГДЕ   РАСПИСАНИЕ? ', 'schedule', 'schedule'],
    ['Где посмотреть мои ОЦЕНКИ?', 'grades', 'grades'],
    ['Где находятся задания?', 'assignments', 'assignments'],
    ['Где найти переписку?', 'messages', 'messages'],
    ['Как мне написать в деканат?', 'contact-dean', 'messages'],
    ['Нужна Справка', 'documents', 'requests'],
    ['Как получить справку об обучении?', 'document-enrollment', 'requests'],
    ['Как подтвердить, что я учусь?', 'document-enrollment', 'requests'],
    ['Как подтвердить период учёбы?', 'document-study-period', 'requests'],
    ['Как получить справку с оценками?', 'document-academic-performance', 'requests'],
    ['Мне нужна справка с суммой стипендии', 'document-scholarship-amount', 'requests'],
    ['Мне нужна справка, что я не получаю стипендию', 'document-no-scholarship', 'requests'],
    ['Какая справка нужна для предъявления по месту требования?', 'document-on-demand', 'requests'],
    ['Мне нужна копия учебного плана', 'document-study-plan', 'requests'],
    ['Где взять выписку из приказа?', 'document-admission-order', 'requests'],
    ['Как проверить статус заявки?', 'document-status', 'requests'],
    ['Как прикрепить файл к заданию?', 'upload-work', 'assignments'],
    ['Я не согласна с оценкой', 'appeal', 'assignments'],
    ['Как ОТОЗВАТЬ апелляцию?', 'withdraw-appeal', 'assignments'],
    ['Как отозвать жалобу на оценку?', 'withdraw-appeal', 'assignments'],
    ['Можно отменить уже поданный запрос на пересмотр оценки?', 'withdraw-appeal', 'assignments'],
  ];
  for (const [query, id, view] of cases) {
    const { answer, found } = answerFor('student', query);
    assert.equal(found, true, query);
    assert.equal(answer.id, id, query);
    assert.equal(answer.view, view, query);
  }
  assert.deepEqual(answerFor('student', 'период учёбы'), answerFor('student', 'период учебы'));
});

test('requirements questions describe the demo and refer users to the dean’s office', () => {
  for (const query of ['Какие документы нужны?', 'Какие документы нужны для справки о размере стипендии?',
    'Как прикрепить файл к заявке на справку?']) {
    const { answer, found } = answerFor('student', query);
    assert.equal(found, true, query);
    assert.equal(answer.id, 'document-requirements', query);
    assert.match(answer.text, /уточните в деканате/i);
    assert.match(answer.text, /в прототипе/i);
    assert.match(answer.text, /личные данные и документы для демонстрационной заявки не требуются/i);
  }
});

test('each role receives only FAQ entries and transitions available to that role', () => {
  const allowed = {
    student: ['schedule', 'grades', 'assignments', 'requests', 'messages'],
    teacher: ['grades', 'assignments', 'messages'],
    dean: ['requests', 'messages'],
  };
  for (const [role, views] of Object.entries(allowed)) {
    const faq = faqFor(role);
    assert.ok(faq.length);
    assert.equal(new Set(faq.map(({ id }) => id)).size, faq.length);
    for (const { view, target, terms } of faq) {
      assert.ok(views.includes(view));
      assert.ok(role === 'student' || target === null);
      assert.ok(terms.length && terms.every((term) => !term.includes('*')));
    }
  }
  assert.deepEqual(faqFor('other'), []);
  assert.equal(answerFor('teacher', 'Как назначить задание?').answer.id, 'assign-work');
  assert.equal(answerFor('teacher', 'Как проверить работу студента?').answer.id, 'review-work');
  assert.equal(answerFor('dean', 'Где посмотреть статус заявки?').answer.id, 'process-request');
  assert.equal(answerFor('teacher', 'Где расписание?').found, false);
  assert.equal(answerFor('teacher', 'Справка об обучении').found, false);
  assert.equal(answerFor('dean', 'Где оценки?').found, false);
  assert.equal(answerFor('dean', 'Справка об обучении').answer.target, null);
});

test('unknown input points to messages and never appears in the answer', () => {
  for (const role of ['student', 'teacher', 'dean']) {
    const unknown = answerFor(role, 'Как вырастить герань?');
    assert.equal(unknown.found, false);
    assert.equal(unknown.answer.view, 'messages');
    assert.equal(unknown.answer.target, null);
    assert.match(unknown.answer.text, /деканат/i);
    assert.deepEqual(answerFor(role, '<script>alert(1)</script>'), unknown);
    assert.deepEqual(answerFor(role, ''), unknown);
  }
  assert.doesNotMatch(answerFor('student', '<b>Где оценки</b>').answer.text, /<\/?b>/);
  assert.equal(answerFor('student', 'Как удалить переписку?').found, false);
  assert.equal(answerFor('student', 'Как отозвать заявку на справку?').found, false);
});
