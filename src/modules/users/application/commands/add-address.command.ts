export interface AddAddressInput {
  recipientName: string;
  phone: string;
  wardCode: string;
  street: string;
  label?: string | null;
  isDefault?: boolean;
}

export class AddAddressCommand {
  constructor(
    public readonly userId: string,
    public readonly input: AddAddressInput,
  ) {}
}
