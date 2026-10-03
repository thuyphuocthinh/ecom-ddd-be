export class ReinstateUserCommand {
  constructor(
    public readonly userId: string,
    /** The administrator who asked, for the log */
    public readonly actorId: string,
  ) {}
}
