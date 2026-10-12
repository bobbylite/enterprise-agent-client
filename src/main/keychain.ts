import { safeStorage } from 'electron';
import { MemorySecretStore, type SecretStore } from '@shared/secrets';
import type { Repository } from './db';

export function createSecretStore(db: Repository): { store: SecretStore; encryptionAvailable: boolean } {
  let encryptionAvailable = false;
  try {
    encryptionAvailable = safeStorage.isEncryptionAvailable();
  } catch {
    // safeStorage throws when the OS keychain is unavailable. Stay on the in-memory store.
  }
  if (!encryptionAvailable) {
    return { store: new MemorySecretStore(), encryptionAvailable: false };
  }
  return {
    encryptionAvailable: true,
    store: {
      async get(account) {
        const blob = db.getSecret(account);
        if (!blob) return null;
        return safeStorage.decryptString(Buffer.from(blob, 'base64'));
      },
      async set(account, value) {
        const encrypted = safeStorage.encryptString(value);
        db.setSecret(account, Buffer.from(encrypted).toString('base64'));
      },
      async delete(account) {
        db.deleteSecret(account);
      },
    },
  };
}
