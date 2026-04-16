'use strict';
const { ok, preflight } = require('./_lib');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  return ok({ status: 'ok', timestamp: new Date().toISOString() });
};
