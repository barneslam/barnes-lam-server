'use strict';
const { ok, err, preflight, fetchAllFathom, fathomToSession, loadSessions, saveSessions } = require('./_lib');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  try {
    const raw = await fetchAllFathom();
    const incoming = raw.map(fathomToSession);

    // Merge with existing — keep existing transcripts if re-syncing
    const existing = await loadSessions();
    const existingMap = Object.fromEntries(existing.map(s => [s.id, s]));
    for (const s of incoming) {
      existingMap[s.id] = { ...(existingMap[s.id] || {}), ...s };
    }
    const merged = Object.values(existingMap);
    await saveSessions(merged);

    return ok({
      success: true,
      sessionCount: merged.length,
      withTranscript: merged.filter(s => s.transcript).length,
      message: 'Sync complete. Run Build Persona to update persona and memory.'
    });
  } catch(e) { return err(e.message); }
};
