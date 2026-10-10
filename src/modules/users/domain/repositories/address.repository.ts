import { Address } from '../entities/address.entity.js';

/**
 * The address book of users. Every method takes the user id and only ever touches that user's
 * addresses; an id that belongs to someone else behaves exactly like an id that does not exist.
 * The writes keep the two rules of the book (at most 10 addresses, exactly one default once there
 * is any address) even when one user sends several requests at once: the repository serialises
 * them per user.
 */
export interface IAddressRepository {
  /** The default address first, then the newest. */
  list(userId: string): Promise<Address[]>;

  findOwned(userId: string, id: string): Promise<Address | null>;

  /**
   * Saves a new address. It becomes the default when it is the user's first, or when
   * `makeDefault` is set (the previous default then stops being the default).
   * Throws ADDR-002 when the user already has 10 addresses.
   */
  add(userId: string, address: Address, makeDefault: boolean): Promise<Address>;

  /** Writes the content of the address (not the default flag). Null when it is not the user's. */
  update(userId: string, address: Address): Promise<Address | null>;

  /** Makes it the user's only default. Null when it is not the user's. */
  setDefault(userId: string, id: string): Promise<Address | null>;

  /**
   * Deletes it; when it was the default, the newest remaining address becomes the default.
   * False when it is not the user's.
   */
  remove(userId: string, id: string): Promise<boolean>;
}
