'use strict';

/**
 * Stripe Checkout, hosted. The card never touches this server and no card data
 * passes through the campground's hands — the guest is redirected to Stripe,
 * pays there, and Stripe tells us about it over a signed webhook.
 *
 * What is charged is the deposit from the quote; the balance is settled at the
 * office on arrival. Change `deposit.mode` in the rate card to take the full
 * amount up front instead.
 */

function money(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

function describe(quote, ref) {
  const n = quote.nights;
  return `${quote.siteTypeName} · ${n} night${n === 1 ? '' : 's'} · ${quote.arrival} to ${quote.departure} · ${ref}`;
}

class StripePayments {
  constructor({ stripe, webhookSecret }) {
    this.stripe = stripe;
    this.webhookSecret = webhookSecret;
  }

  async createCheckout({ quote, request, ref, eventId, publicUrl }) {
    const depositLabel =
      quote.deposit === quote.total ? 'Payment in full' : `Deposit (balance ${money(quote.balance)} on arrival)`;

    return this.stripe.checkout.sessions.create(
      {
        mode: 'payment',
        customer_email: request.email,
        client_reference_id: ref,
        // Stripe's floor for session expiry is 30 minutes; the site hold is set
        // to outlast it so a session can never outlive its hold.
        expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: quote.currency,
              unit_amount: quote.deposit,
              product_data: {
                name: `All Points East Campground — ${quote.siteTypeName}`,
                description: `${describe(quote, ref)} · ${depositLabel}`,
              },
            },
          },
        ],
        payment_intent_data: {
          description: describe(quote, ref),
          metadata: { ref, eventId },
        },
        metadata: {
          ref,
          eventId,
          siteTypeId: quote.siteTypeId,
          arrival: quote.arrival,
          departure: quote.departure,
          nights: String(quote.nights),
          guests: String(request.guests),
          totalCents: String(quote.total),
          balanceCents: String(quote.balance),
        },
        success_url: `${publicUrl}/?booking=confirmed&ref=${encodeURIComponent(ref)}`,
        cancel_url: `${publicUrl}/?booking=cancelled#book`,
      },
      // If the guest double-clicks, Stripe returns the same session rather than
      // opening a second one against the same hold.
      { idempotencyKey: `checkout_${ref}` }
    );
  }

  parseWebhook(rawBody, signature) {
    return this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
  }

  /**
   * Refund a deposit. Keyed on the booking reference, so a guest who
   * double-clicks cancel gets one refund rather than two.
   */
  async refund(paymentRef, amountCents, ref) {
    return this.stripe.refunds.create(
      { payment_intent: paymentRef, amount: amountCents, metadata: { ref } },
      { idempotencyKey: `refund_${ref}` }
    );
  }
}

module.exports = { StripePayments, describe, money };
