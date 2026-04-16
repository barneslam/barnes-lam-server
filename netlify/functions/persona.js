'use strict';
const { ok, err, preflight, loadPersona } = require('./_lib');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  try {
    const persona = await loadPersona();
    return ok({ success: true, persona });
  } catch(e) { return err(e.message); }
};
