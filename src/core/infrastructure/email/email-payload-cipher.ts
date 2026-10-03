import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from 'crypto';
import type { EmailMessage } from './email-sender.port.js';

const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Encrypts an email while it waits in the job queue. It can hold a one-time code, and a
 * code that sat in the broker in plain text would be readable by anyone who can see the
 * broker. AES-256-GCM, so a payload that was changed in transit does not decrypt either.
 * The key is derived from the server secret under its own label, so no new secret has to
 * be configured and the key differs from every other key derived from that secret.
 */
export class EmailPayloadCipher {
  private readonly key: Buffer;

  constructor(secret: string) {
    this.key = createHmac('sha256', secret).update('jobs-email-v1').digest();
  }

  /** `iv.tag.ciphertext`, each part base64. A fresh random IV every time. */
  encrypt(message: EmailMessage): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv, {
      authTagLength: TAG_BYTES,
    });
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(message), 'utf8'),
      cipher.final(),
    ]);
    return [iv, cipher.getAuthTag(), ciphertext]
      .map((part) => part.toString('base64'))
      .join('.');
  }

  /** Throws when the payload is malformed, was altered, or was made with another key. */
  decrypt(payload: string): EmailMessage {
    const [iv, tag, ciphertext] = payload
      .split('.')
      .map((part) => Buffer.from(part, 'base64'));
    // A shortened tag would still "verify", with a far weaker guarantee, so only the full length is accepted
    if (
      !iv ||
      !tag ||
      !ciphertext ||
      iv.length !== IV_BYTES ||
      tag.length !== TAG_BYTES
    ) {
      throw new Error('Malformed email payload');
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return JSON.parse(plain.toString('utf8')) as EmailMessage;
  }
}
