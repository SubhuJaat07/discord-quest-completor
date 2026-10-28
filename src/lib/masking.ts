// ============================================================
// Credential masking — private build
// ------------------------------------------------------------
// Single source of truth for masking credentials before they may
// enter a webhook payload. Pure functions, no I/O.
//
// Policy (ops-log standard, Stripe-style):
//   token  → only the FIRST dot-segment is visible — that segment
//            is just base64(user id), i.e. public info already
//            present as user.id. The timestamp + hmac segments
//            (the actual secret material) are always "****".
//   email  → first character + "****" + @domain
//   phone  → "****" + last 4 digits
//
// None of the returned strings can authenticate anyone or
// identify an account beyond what is already public.
// ============================================================

/** "MTIzNDU2....****.****" — format visible, secret segments hidden. */
export function maskToken(token: string): string | null {
  if (!token || typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length === 3) {
    // parts[0] = base64(user id) — public; parts[1..2] = secret material.
    return `${parts[0]}.****.****`
  }
  // Unknown shape: show only a 4-char hint.
  return `${token.slice(0, 4)}****`
}

/** "s****@gmail.com" — first char + domain visible, rest hidden. */
export function maskEmail(email?: string | null): string | null {
  if (!email || typeof email !== 'string') return null
  const at = email.lastIndexOf('@')
  if (at <= 0) return '****'
  const domain = email.slice(at) // includes "@"
  return `${email.slice(0, 1)}****${domain}`
}

/** "****1234" — last 4 digits visible, rest hidden. */
export function maskPhone(phone?: string | null): string | null {
  if (!phone || typeof phone !== 'string') return null
  const digits = phone.replace(/\D/g, '')
  if (digits.length < 4) return '****'
  return `****${digits.slice(-4)}`
}
