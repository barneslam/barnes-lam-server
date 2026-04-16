'use strict';
const { ok, err, preflight, loadEmails, saveEmails } = require('./_lib');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  try {
    const { emails: incoming } = JSON.parse(event.body || '{}');
    if (!Array.isArray(incoming) || !incoming.length)
      return err('emails array required', 400);

    const existing = await loadEmails();
    const existingIds = new Set(existing.map(e => e.id));
    const newEmails = incoming.filter(e => e.id && !existingIds.has(e.id));

    if (!newEmails.length)
      return ok({ success: true, added: 0, total: existing.length, message: 'All emails already in knowledge base' });

    const merged = [...existing, ...newEmails];
    await saveEmails(merged);
    return ok({ success: true, added: newEmails.length, total: merged.length });
  } catch(e) { return err(e.message); }
};
