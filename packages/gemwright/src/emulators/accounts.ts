import { createHash, randomBytes } from 'node:crypto';

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

export function ownerAccountXml(owner: string, password: string, algorithm: string, element: string): string {
  const digest = createHash(algorithm)
    .update(algorithm === 'md5' ? password : owner + password, 'ascii')
    .digest('hex')
    .toUpperCase()
    .match(/../g)
    ?.join('-');
  return `<?xml version="1.0" encoding="utf-8"?>\n<accounts count="1">\n  <account>\n    <username>${owner}</username>\n    <${element}>${digest}</${element}>\n    <accessLevel>Owner</accessLevel>\n  </account>\n</accounts>\n`;
}
