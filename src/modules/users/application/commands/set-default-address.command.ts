export class SetDefaultAddressCommand {
  constructor(
    public readonly userId: string,
    public readonly addressId: string,
  ) {}
}
