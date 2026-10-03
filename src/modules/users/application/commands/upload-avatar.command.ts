export class UploadAvatarCommand {
  constructor(
    public readonly userId: string,
    /** The file exactly as received; undefined when the request carried none. */
    public readonly image: Buffer | undefined,
  ) {}
}
