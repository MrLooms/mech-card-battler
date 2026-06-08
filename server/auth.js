const jwt = require("jsonwebtoken");

/**
 * Decode a Supabase JWT without signature verification.
 * Supabase already authenticated the user via HTTP — we just need the sub/user_id.
 * Returns the decoded payload or null on failure / expiry.
 */
function verifyToken(token) {
  try {
    const decoded = jwt.decode(token);
    if (!decoded || !decoded.sub) {
      console.error("JWT decode: missing sub");
      return null;
    }
    // Reject expired tokens
    if (decoded.exp && decoded.exp < Math.floor(Date.now() / 1000)) {
      console.error("JWT decode: token expired");
      return null;
    }
    return decoded;
  } catch (e) {
    console.error("JWT decode error:", e.message);
    return null;
  }
}

module.exports = { verifyToken };
