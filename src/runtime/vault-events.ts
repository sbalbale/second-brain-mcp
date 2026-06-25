type VaultMutationListener = (vaultRoot: string, relPath: string) => void | Promise<void>;

const mutationListeners = new Set<VaultMutationListener>();

export function onVaultMutation(listener: VaultMutationListener): () => void {
  mutationListeners.add(listener);
  return () => {
    mutationListeners.delete(listener);
  };
}

export async function notifyVaultMutation(vaultRoot: string, relPath: string): Promise<void> {
  await Promise.all(
    [...mutationListeners].map(async (listener) => {
      try {
        await listener(vaultRoot, relPath);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[Vault] Mutation listener failed: ${message}`);
      }
    }),
  );
}
