const jwt        = require("jsonwebtoken");
const jwksClient = require("jwks-rsa");
require("dotenv").config();

const SUPABASE_URL = process.env.SUPABASE_URL; // e.g. https://xxxx.supabase.co

const client = jwksClient({
  jwksUri:   `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`,
  cache:     true,
  rateLimit: true,
});

function getKey(header, callback) {
  client.getSigningKey(header.kid, (err, key) => {
    if (err) return callback(err);
    callback(null, key.getPublicKey());
  });
}

/**
 * Verify a Supabase JWT (RS256/ES256 via JWKS, or HS256 fallback).
 * Returns a Promise that resolves to the decoded payload or null.
 */
function verifyToken(token) {
  return new Promise((resolve) => {
    jwt.verify(token, getKey, { algorithms: ["RS256", "ES256", "HS256"] }, (err, decoded) => {
      if (err) {
        console.error("JWT verify error:", err.message);
        resolve(null);
      } else {
        resolve(decoded);
      }
    });
  });
}

module.exports = { verifyToken };
