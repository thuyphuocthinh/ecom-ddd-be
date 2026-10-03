/** The kinds of image that are accepted, decided from the first bytes of the file. */
export type ImageType = 'jpeg' | 'png' | 'webp';

/** How a picture is cut to size when it is stored. */
export interface ImageFit {
  width: number;
  height: number;
  /** `fill`: exactly this size, cutting the edges. `limit`: shrink to fit inside, never enlarge. */
  crop: 'fill' | 'limit';
  /** With `fill`, what to keep in the middle: a detected face (else the centre), or the centre. */
  focus?: 'face' | 'center';
}

export interface ImageUpload {
  /**
   * Where the picture lives, as names separated by "/" (letters, digits, "_" and "-"), e.g.
   * `avatars/123`. Uploading to a path that has a picture replaces it, so the caller decides
   * whether a thing has one picture (a fixed path) or many (a path per picture).
   */
  path: string;
  image: Buffer;
  type: ImageType;
  fit: ImageFit;
}

export const IMAGE_STORAGE = 'IImageStorage';

/**
 * Where pictures are kept (avatars now; product photos and the like later). The features know
 * what to store and where, never which service does it.
 */
export interface IImageStorage {
  /** Stores the picture and returns the https address it can be shown from. */
  upload(request: ImageUpload): Promise<string>;

  /** Removes the picture at this path. Succeeds when there is none. */
  delete(path: string): Promise<void>;
}
