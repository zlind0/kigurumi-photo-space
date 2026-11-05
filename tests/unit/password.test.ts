import { describe, expect, it } from 'vitest';
import {
  generatePassword,
  hashPassword,
  passwordLookup,
  validatePassword,
  verifyPassword,
} from '../../src/server/auth/password.js';

describe('password hashing', () => {
  it('hashes and verifies a password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
    expect(await verifyPassword('wrong password', hash)).toBe(false);
  });

  it('uses a unique salt per hash', async () => {
    const a = await hashPassword('same-password');
    const b = await hashPassword('same-password');
    expect(a).not.toBe(b);
    expect(await verifyPassword('same-password', a)).toBe(true);
    expect(await verifyPassword('same-password', b)).toBe(true);
  });

  it('rejects malformed hashes', async () => {
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$1$2$3$bad$bad')).toBe(false);
  });

  it('derives a deterministic lookup key', () => {
    const a = passwordLookup('pepper', 'password');
    const b = passwordLookup('pepper', 'password');
    const c = passwordLookup('other-pepper', 'password');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it('validates password length', () => {
    expect(validatePassword('12345678')).toBe('12345678');
    expect(() => validatePassword('short')).toThrow();
    expect(() => validatePassword('x'.repeat(129))).toThrow();
    expect(() => validatePassword(123)).toThrow();
  });

  it('generates 16-character passwords', () => {
    const password = generatePassword();
    expect(password.length).toBe(16);
    expect(password).not.toBe(generatePassword());
  });
});
