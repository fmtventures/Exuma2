'use strict';

/**
 * Booking email. Two go out when a reservation is paid: one to the guest with
 * everything they need on arrival day, and one to the office so a booking is
 * noticed even when nobody is watching the calendar.
 *
 * Mail is a courtesy, not part of the transaction — a mail server having a bad
 * morning must never cost the campground a paid booking. Every send is wrapped
 * so a failure is logged and swallowed, and the booking stands on its own.
 */

const CAMPGROUND = {
  name: 'All Points East Campground',
  address: '515 North Lake Harbour Road, Lakeville (Souris), PE C0A 2B0',
  phone: '(902) 327-0356',
  tel: '+19023270356',
  email: 'camp@allpointseastcampground.ca',
  directions:
    'https://www.google.com/maps/search/?api=1&query=515+North+Lake+Harbour+Road+Lakeville+PE+C0A+2B0',
};

const money = (cents) => `$${(cents / 100).toFixed(2)}`;

function prettyDate(date) {
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const [y, m, d] = date.split('-').map(Number);
  const weekday = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][
    new Date(Date.UTC(y, m - 1, d)).getUTCDay()
  ];
  return `${weekday}, ${months[m - 1]} ${d}, ${y}`;
}

function guestConfirmation({ booking, quote, checkIn, checkOut, cancelLink, cancellation }) {
  const nights = `${quote.nights} night${quote.nights === 1 ? '' : 's'}`;

  // Optional lines are null and dropped; empty strings are paragraph breaks and
  // are kept, so the letter reads the way it was written.
  const lines = [
    `Hello ${booking.name.split(' ')[0]},`,
    '',
    `You're booked at ${CAMPGROUND.name}. Here are the details:`,
    '',
    `  Reference:  ${booking.ref}`,
    `  Site:       ${quote.siteTypeName}`,
    `  Arriving:   ${prettyDate(quote.arrival)} — check-in from ${checkIn}`,
    `  Leaving:    ${prettyDate(quote.departure)} — check-out by ${checkOut}`,
    `  Stay:       ${nights}, ${booking.guests} guest${booking.guests === 1 ? '' : 's'}`,
    '',
    `  Paid today:        ${money(quote.deposit)}`,
    quote.balance > 0 ? `  Due on arrival:    ${money(quote.balance)}` : '  Paid in full — nothing owing on arrival.',
    `  Total:             ${money(quote.total)} (includes ${quote.taxLabel} ${money(quote.tax)})`,
    '',
    'FINDING US',
    `  ${CAMPGROUND.address}`,
    `  ${CAMPGROUND.directions}`,
    '',
    "Stop at the office when you arrive and we'll walk you to your site.",
    '',
    'NEED TO CHANGE OR CANCEL?',
    cancellation.guestCancelUntilDays
      ? `  You can cancel online up to ${cancellation.guestCancelUntilDays} day${cancellation.guestCancelUntilDays === 1 ? '' : 's'} before you arrive:`
      : '  You can cancel online here:',
    `  ${cancelLink}`,
    cancellation.refundDepositUntilDays
      ? `  Deposits are refunded in full when you cancel at least ${cancellation.refundDepositUntilDays} days before arrival.`
      : null,
    `  Anything else, call us at ${CAMPGROUND.phone} — we're happy to help.`,
    '',
    'See you on the east end,',
    CAMPGROUND.name,
    `${CAMPGROUND.phone} · ${CAMPGROUND.email}`,
  ];

  return {
    subject: `You're booked — ${prettyDate(quote.arrival)} · ${booking.ref}`,
    text: lines.filter((line) => line !== null).join('\n'),
  };
}

function officeNotification({ booking, quote }) {
  return {
    subject: `New booking — ${quote.siteTypeName}, ${quote.arrival} · ${booking.ref}`,
    text: [
      `${booking.name} booked ${quote.siteTypeName} for ${quote.nights} night${quote.nights === 1 ? '' : 's'}.`,
      '',
      `  Reference: ${booking.ref}`,
      `  Arriving:  ${quote.arrival}`,
      `  Leaving:   ${quote.departure}`,
      `  Guests:    ${booking.guests}`,
      `  Email:     ${booking.email}`,
      `  Phone:     ${booking.phone || '—'}`,
      booking.notes ? `  Notes:     ${booking.notes}` : null,
      '',
      `  Paid online:        ${money(quote.deposit)}`,
      `  Balance on arrival: ${money(quote.balance)}`,
      '',
      'It is on the bookings calendar.',
    ].filter((line) => line !== null).join('\n'),
  };
}

function cancellationNotice({ booking, refundCents, byOffice }) {
  const refunded = refundCents > 0
    ? `A refund of ${money(refundCents)} is on its way back to your card — it usually lands within a few business days.`
    : 'No refund was due under the cancellation policy for these dates.';

  return {
    subject: `Booking cancelled — ${booking.ref}`,
    text: [
      `Hello ${booking.name.split(' ')[0]},`,
      '',
      `Your booking ${booking.ref} for ${prettyDate(booking.arrival)} has been cancelled${byOffice ? ' by the campground' : ''}.`,
      '',
      refunded,
      '',
      `If this was a mistake, call us at ${CAMPGROUND.phone} and we'll see what's still open.`,
      '',
      CAMPGROUND.name,
    ].join('\n'),
  };
}

/** Writes mail to the log instead of sending it. Used until SMTP is configured. */
class ConsoleMailer {
  constructor() {
    this.sent = [];
  }

  async send({ to, subject, text }) {
    this.sent.push({ to, subject, text });
    // The body matters as much as the subject here: it carries the guest's
    // cancellation link, which is the only way to try that flow before SMTP
    // is switched on.
    console.log(
      [
        `▸ [mail not sent — SMTP unconfigured]`,
        `  To:      ${to}`,
        `  Subject: ${subject}`,
        text.split('\n').map((line) => `  | ${line}`).join('\n'),
        '',
      ].join('\n')
    );
    return { skipped: true };
  }
}

class SmtpMailer {
  constructor({ transport, from, replyTo }) {
    this.transport = transport;
    this.from = from;
    this.replyTo = replyTo;
  }

  async send({ to, subject, text }) {
    return this.transport.sendMail({ from: this.from, replyTo: this.replyTo, to, subject, text });
  }
}

/** Never let a mail failure escape into the booking flow. */
async function trySend(mailer, message) {
  if (!mailer) return { skipped: true };
  try {
    return await mailer.send(message);
  } catch (err) {
    console.error(`Could not send "${message.subject}" to ${message.to}:`, err.message);
    return { failed: true, error: err.message };
  }
}

module.exports = {
  CAMPGROUND,
  ConsoleMailer,
  SmtpMailer,
  guestConfirmation,
  officeNotification,
  cancellationNotice,
  trySend,
  prettyDate,
};
