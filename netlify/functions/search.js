'use strict';
const { ok, err, preflight, loadSessions, searchSessions } = require('./_lib');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  try {
    const { query, topK = 5 } = JSON.parse(event.body || '{}');
    if (!query) return err('query required', 400);
    const sessions = await loadSessions();
    const results = searchSessions(sessions, query, topK).map(s => ({
      type: 'session', id: s.id, title: s.title, date: s.date, duration: s.duration,
      participants: s.participants || [],
      excerpt: (s.transcript || '').substring(0, 300) + '...'
    }));
    return ok({ success: true, count: results.length, results });
  } catch(e) { return err(e.message); }
};
