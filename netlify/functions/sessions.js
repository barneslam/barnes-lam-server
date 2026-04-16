'use strict';
const { ok, err, preflight, loadSessions } = require('./_lib');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  try {
    const sessions = await loadSessions();
    return ok({
      success: true,
      count: sessions.length,
      sessions: sessions.map(s => ({
        id: s.id, title: s.title, date: s.date, duration: s.duration,
        participants: s.participants || [], hasTranscript: !!(s.transcript)
      }))
    });
  } catch(e) { return err(e.message); }
};
