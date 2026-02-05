export default function handler(req, res) {
  const key = process.env.STRIPE_SECRET_KEY;
  res.status(200).json({
    hasStripeSecretKey: !!key,
    stripeSecretKeyLength: key ? key.length : 0,
    stripeSecretKeyPrefix: key ? key.slice(0, 7) : null, // should look like "sk_test"
    siteBaseUrlSet: !!process.env.SITE_BASE_URL
  });
}
