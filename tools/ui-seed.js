const fixed = (time) => ({ mode: 'fixed', time });
const base = (extra) => ({ start: fixed('09:00'), durationMinutes: 30, date: '2026-10-04', recurrence: null,
  reminders: { enabled: true, offsets: [] }, priority: 'Medium', categoryId: null, notes: '', ...extra });
module.exports = function seed(service) {
  const mk = (f) => service.saveTask({ mode: 'create', form: base(f) }).taskId;
  const morning = mk({ title: 'Morning Routine', start: fixed('07:00'), durationMinutes: 45, categoryId: 'cat-personal' });
  service.setDone({ taskId: morning, dateKey: '2026-10-04', done: true });
  mk({ title: 'Study SQL', start: fixed('08:00'), durationMinutes: 90, priority: 'High', categoryId: 'cat-study',
       recurrence: { startDate: '2026-10-01', frequency: 'daily', interval: 1 }, reminders: { enabled: true, offsets: [15, 0] } });
  mk({ title: 'Exercise', start: fixed('10:00'), durationMinutes: 45, categoryId: 'cat-health', priority: 'Low', reminders: { enabled: false, offsets: [] } });
  mk({ title: 'Long call with the team', start: fixed('11:30'), durationMinutes: 60, categoryId: 'cat-work' });
  mk({ title: 'Review notes', start: fixed('11:45'), durationMinutes: 20, categoryId: 'cat-work' });
  mk({ title: 'Read Quran', start: { mode: 'prayer', prayer: 'asr', direction: 'after', minutes: 10 }, durationMinutes: 30, categoryId: 'cat-worship',
       recurrence: { startDate: '2026-10-04', frequency: 'daily', interval: 1 } });
  mk({ title: 'مراجعة الدرس', start: fixed('20:30'), durationMinutes: 60, categoryId: 'cat-study' });
  mk({ title: 'Gym', start: fixed('18:30'), durationMinutes: 60, categoryId: 'cat-health',
       recurrence: { startDate: '2026-10-02', frequency: 'weekly', interval: 1, weekdays: [5] } });
  mk({ title: 'Night reading', start: fixed('02:00'), durationMinutes: 45, date: '2026-10-05', categoryId: 'cat-worship' });
};
