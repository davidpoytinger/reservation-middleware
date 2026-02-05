export default function handler(req, res) {
  const stripeKey = process.env.STRIPE_SECRET_KEY;

  res.status(200).json({
    hasStripeSecretKey: !!stripeKey,
    stripeSecretKeyPrefix: stripeKey ? stripeKey.slice(0, 7) : null,
    siteBaseUrlSet: !!process.env.SITE_BASE_URL,

    caspio: {
      accountSet: !!process.env.CASPIO_ACCOUNT,
      clientIdSet: !!process.env.CASPIO_CLIENT_ID,
      clientSecretSet: !!process.env.CASPIO_CLIENT_SECRET,
      tableSet: !!process.env.CASPIO_TABLE,
      keyField: process.env.CASPIO_KEY_FIELD || null,
    },
  });
}
