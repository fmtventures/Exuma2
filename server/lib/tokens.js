'use strict';

const crypto = require('crypto');

/**
 * Cancellation links have to be usable from an email, with no account and no
 * password, while still keeping one guest out of another guest's booking.
 *
 * The link carries the booking reference and a short HMAC of it. Knowing a
 * reference is not enough to cancel; you need the signature, which only this
 * server can produce. Comparison is constant-time so the signature cannot be
 * guessed a character at a time.
 */

function sign(ref, secret) {
  return crypto.createHmac('sha256', secret).update(`cancel:${ref}`).digest('hex').slice(0, 32);
}

function verify(ref, token, secret) {
  if (typeof token !== 'string' || token.length !== 32) return false;
  const expected = Buffer.from(sign(ref, secret));
  const given = Buffer.from(token);
  if (expected.length !== given.length) return false;
  return crypto.timingSafeEqual(expected, given);
}

function cancelUrl(publicUrl, ref, secret) {
  return `${publicUrl}/?cancel=${encodeURIComponent(ref)}&t=${sign(ref, secret)}#book`;
}

module.exports = { sign, verify, cancelUrl };
