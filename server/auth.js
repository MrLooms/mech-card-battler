const jwt = require("jsonwebtoken");
require("dotenv").config();

const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

/**
 * Verify a Supabase JWT token.
 * Returns the decoded payload ({ sub, email, user_metadata, ... }) or null.
 */
function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

module.exports = { verifyToken };
