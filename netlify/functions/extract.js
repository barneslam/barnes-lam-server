'use strict';
const { ok, err, preflight, fetchAllFathom, fathomToSession, saveSessions } = require('./_lib');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  try {
    const raw = await fetchAllFathom();
    const sessions = raw.map(fathomToSession);
    await saveSessions(sessions);
    return ok({
      success: true,
      sessionCount: sessions.length,
      withTranscript: sessions.filter(s => s.transcript).length,
      message: 'Extraction complete. Run build-persona to rebuild persona and memory.'
    });
  } catch(e) { return err(e.message); }
};
