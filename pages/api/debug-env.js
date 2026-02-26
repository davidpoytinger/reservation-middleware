// pages/api/debug-env.js
export default function handler(req, res) {
  res.status(200).json({
    CASPIO_INTEGRATION_URL: process.env.CASPIO_INTEGRATION_URL || null,
    CASPIO_TOKEN_URL: process.env.CASPIO_TOKEN_URL || null,
    CASPIO_TABLE: process.env.CASPIO_TABLE || null,
    CASPIO_TXN_TABLE: process.env.CASPIO_TXN_TABLE || null,
    VERCEL_ENV: process.env.VERCEL_ENV || null,
  });
}
