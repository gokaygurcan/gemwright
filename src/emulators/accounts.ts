import { randomBytes } from 'node:crypto';

export function validateOwner(value: string): string | undefined {
  if (!/^[A-Za-z0-9_-]{1,16}$/.test(value)) return 'Use 1-16 letters, numbers, underscores or hyphens.';
}

export function validateOwnerPassword(value: string): string | undefined {
  if (value !== '' && !/^[\x20-\x7e]{8,16}$/.test(value))
    return 'Use 8-16 printable ASCII characters, or leave blank to generate a password.';
}

export function generatedOwnerPassword(): string {
  return randomBytes(12).toString('base64url');
}
