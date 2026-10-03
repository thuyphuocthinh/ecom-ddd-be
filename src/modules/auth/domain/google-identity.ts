/** What Google vouches for about a person, taken from a verified ID token. */
export interface GoogleIdentity {
  /** Google's stable id for the person. Never changes, unlike the email. */
  sub: string;
  /** Lower-cased and trimmed. */
  email: string;
  emailVerified: boolean;
  name?: string;
  picture?: string;
  nonce?: string;
  /** When the token stops being valid. */
  expiresAt: Date;
  /**
   * Identifies the token by what Google SIGNED (issuer, audience, subject, times, id, nonce), never
   * by the text it arrived as. The same signed token can be written in several ways (extra
   * whitespace, unused bits in the signature) that all verify, so a hash of the text would let a
   * used token be played again with one character changed.
   */
  tokenId: string;
}

/**
 * Checks an ID token and says who it is about. Rejects with AUTH-014 when the token is not
 * good (bad signature, wrong issuer or audience, expired, too old...) and with a 503 when
 * Google's keys cannot be fetched, so an outage is never mistaken for a bad token.
 */
export interface IGoogleTokenVerifier {
  verify(idToken: string): Promise<GoogleIdentity>;
}

/** DI token for the active IGoogleTokenVerifier. */
export const GOOGLE_TOKEN_VERIFIER = 'IGoogleTokenVerifier';
