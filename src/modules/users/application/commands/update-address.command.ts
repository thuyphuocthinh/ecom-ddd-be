/** Only the fields that are present are changed; `label: null` removes the label. */
export interface UpdateAddressChanges {
  recipientName?: string;
  phone?: string;
  wardCode?: string;
  street?: string;
  label?: string | null;
}

export class UpdateAddressCommand {
  constructor(
    public readonly userId: string,
    public readonly addressId: string,
    public readonly changes: UpdateAddressChanges,
  ) {}
}
