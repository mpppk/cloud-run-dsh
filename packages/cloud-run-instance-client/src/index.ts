// Cloud Run Instance client adapter — GCP SDK isolated here
export interface InstanceInfo {
  readonly name: string;
  readonly url: string | undefined;
  readonly state: string;
}

export interface InstanceRuntime {
  create(workspace: { id: string }): Promise<InstanceInfo>;
  start(instanceName: string): Promise<void>;
  stop(instanceName: string): Promise<void>;
  get(instanceName: string): Promise<InstanceInfo>;
  delete(instanceName: string): Promise<void>;
}

export interface CloudRunInstanceClientPlaceholder {
  readonly kind: "cloud-run-instance-client";
}

export const PLACEHOLDER_KIND = "cloud-run-instance-client" as const;

export function createPlaceholder(): CloudRunInstanceClientPlaceholder {
  return { kind: PLACEHOLDER_KIND } as CloudRunInstanceClientPlaceholder;
}
