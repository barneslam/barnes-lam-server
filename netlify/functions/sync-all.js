'use strict';
const { ok, err, preflight, fetchAllFathom, fathomToSession, loadSessions, saveSessions, loadEmails, loadPodcasts, loadWebsite, dbLoad } = require('./_lib');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  try {
    // ── Fathom — merge-safe sync ───────────────────────────────────────────────
    const raw = await fetchAllFathom();
    const incoming = raw.map(fathomToSession);
    const existing = await loadSessions();
    const existingMap = Object.fromEntries(existing.map(s => [s.id, s]));
    const beforeCount = Object.keys(existingMap).length;
    for (const s of incoming) {
      existingMap[s.id] = { ...(existingMap[s.id] || {}), ...s };
    }
    const merged = Object.values(existingMap);
    const newCount = merged.length - beforeCount;
    await saveSessions(merged);

    // ── Counts from all other sources ─────────────────────────────────────────
    const [emails, podcasts, website] = await Promise.all([
      loadEmails(), loadPodcasts(), loadWebsite()
    ]);

    return ok({
      success: true,
      sessions: { total: merged.length, newCount, withTranscript: merged.filter(s => s.transcript).length },
      emails: emails.length,
      podcasts: podcasts.length,
      website: website.length,
      message: 'Sync complete. Run Build Persona to update persona and memory.'
    });
  } catch(e) { return err(e.message); }
};
