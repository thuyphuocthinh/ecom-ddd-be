export interface RepositoryPort<Entity> {
  insert(entity: Entity): Promise<void>;
  findOneById(id: string): Promise<Entity | null>;
  findAll(): Promise<Entity[]>;
  delete(entity: Entity): Promise<boolean>;
}
