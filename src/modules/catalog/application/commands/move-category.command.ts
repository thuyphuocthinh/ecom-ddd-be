export class MoveCategoryCommand {
  constructor(
    public readonly id: string,
    public readonly newParentId: string | null,
  ) {}
}
