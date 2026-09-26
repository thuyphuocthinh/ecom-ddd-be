import { snowflake } from '../../utils/snowflake.util.js';

export abstract class Entity<EntityProps> {
  protected readonly _id: string;
  protected props: EntityProps;
  public readonly createdAt: Date;
  public updatedAt: Date;

  constructor(props: EntityProps, id?: string) {
    this._id = id ? id : snowflake.nextId();
    this.createdAt = new Date();
    this.updatedAt = new Date();
    this.props = props;
  }

  get id(): string {
    return this._id;
  }

  getProps(): EntityProps {
    return this.props;
  }

  public equals(object?: Entity<EntityProps>): boolean {
    if (object == null || object == undefined) {
      return false;
    }
    if (this === object) {
      return true;
    }
    if (!(object instanceof Entity)) {
      return false;
    }
    return this._id === object._id;
  }
}
