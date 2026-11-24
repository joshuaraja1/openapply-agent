export interface SecretStore {
  get(reference: string): Promise<string | undefined>;
  put(reference: string, value: string): Promise<void>;
  delete(reference: string): Promise<void>;
}

export interface SessionStore {
  read(profileId: string): Promise<Uint8Array | undefined>;
  write(profileId: string, data: Uint8Array): Promise<void>;
  delete(profileId: string): Promise<void>;
}

export interface ApplicationStateStore<State> {
  read(applicationId: string): Promise<{ version: number; state: State } | undefined>;
  compareAndSwap(
    applicationId: string,
    expectedVersion: number | undefined,
    state: State,
  ): Promise<number | undefined>;
  delete(applicationId: string, expectedVersion: number): Promise<boolean>;
}

/** Test implementation. Production state requires encrypted durable persistence. */
export class MemoryApplicationStateStore<State> implements ApplicationStateStore<State> {
  private readonly values = new Map<string, { version: number; state: State }>();
  private readonly generations = new Map<string, number>();

  async read(applicationId: string): Promise<{ version: number; state: State } | undefined> {
    const value = this.values.get(applicationId);
    return value && { version: value.version, state: structuredClone(value.state) };
  }

  async compareAndSwap(
    applicationId: string,
    expectedVersion: number | undefined,
    state: State,
  ): Promise<number | undefined> {
    const current = this.values.get(applicationId);
    if (current?.version !== expectedVersion) return undefined;
    const version = (this.generations.get(applicationId) ?? 0) + 1;
    this.generations.set(applicationId, version);
    this.values.set(applicationId, { version, state: structuredClone(state) });
    return version;
  }

  async delete(applicationId: string, expectedVersion: number): Promise<boolean> {
    if (this.values.get(applicationId)?.version !== expectedVersion) return false;
    return this.values.delete(applicationId);
  }
}
