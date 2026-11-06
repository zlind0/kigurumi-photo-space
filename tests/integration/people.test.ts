import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { authHeaders, createTestContext, login, multipart, type TestContext } from './helpers.js';

const avatar = readFileSync(fileURLToPath(new URL('../fixtures/avatar.avif', import.meta.url)));

let context: TestContext;
let app: FastifyInstance;
let adminCookie = '';
let albumId = 0;
let personId = 0;
let avatarUrl = '';

beforeAll(async () => {
  context = await createTestContext();
  app = context.app;
  const result = await login(app, 'admin-password-123');
  adminCookie = result.cookie;
  const album = await app.inject({
    method: 'POST',
    url: '/api/albums',
    headers: { ...authHeaders(adminCookie), 'content-type': 'application/json' },
    payload: { name: '人物测试' },
  });
  albumId = album.json().album.id;
});

afterAll(async () => {
  await context.cleanup();
});

describe('people API', () => {
  it('creates a person with a 200x200 AVIF avatar', async () => {
    const body = multipart(
      { name: 'Fried', hue: '28', saturation: '72', lightness: '80' },
      [{ field: 'avatar', filename: 'avatar.avif', contentType: 'image/avif', data: avatar }],
    );
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/people',
      headers: { ...authHeaders(adminCookie), ...body.headers },
      payload: body.payload,
    });
    expect(response.statusCode).toBe(201);
    const person = response.json().person;
    personId = person.id;
    avatarUrl = person.avatarUrl;
    expect(person.name).toBe('Fried');
    expect(person.accent).toBe('hsl(28 72% 80%)');
    expect(avatarUrl).toMatch(/^\/p\/[a-f0-9]{32}\.avif$/);
  });

  it('serves the avatar with immutable caching', async () => {
    const response = await app.inject({ method: 'GET', url: avatarUrl });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/avif');
    expect(response.headers['cache-control']).toContain('immutable');
  });

  it('lists people publicly', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/people' });
    expect(response.statusCode).toBe(200);
    expect(response.json().people.map((person: { name: string }) => person.name)).toContain('Fried');
  });

  it('tags an album with people', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: `/api/albums/${albumId}/people`,
      headers: { ...authHeaders(adminCookie), 'content-type': 'application/json' },
      payload: { personIds: [personId] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().people).toHaveLength(1);
    const detail = await app.inject({ method: 'GET', url: `/api/albums/${albumId}` });
    expect(detail.json().album.people[0].id).toBe(personId);
  });

  it('filters albums by person', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/albums?people=${personId}` });
    expect(response.statusCode).toBe(200);
    expect(response.json().albums.map((album: { id: number }) => album.id)).toContain(albumId);
  });

  it('updates a person without replacing the avatar', async () => {
    const body = multipart({ name: 'Fried II', hue: '200', saturation: '60', lightness: '75' }, []);
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/admin/people/${personId}`,
      headers: { ...authHeaders(adminCookie), ...body.headers },
      payload: body.payload,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().person.name).toBe('Fried II');
    expect(response.json().person.accent).toBe('hsl(200 60% 75%)');
    expect(response.json().person.avatarUrl).toBe(avatarUrl);
  });

  it('rejects a non-200x200 avatar', async () => {
    const body = multipart(
      { name: 'Bad Avatar' },
      [{ field: 'avatar', filename: 'avatar.avif', contentType: 'image/avif', data: readFileSync(fileURLToPath(new URL('../fixtures/thumb.avif', import.meta.url))) }],
    );
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/people',
      headers: { ...authHeaders(adminCookie), ...body.headers },
      payload: body.payload,
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('INVALID_AVATAR');
  });

  it('deletes a person and clears album tags', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/admin/people/${personId}`,
      headers: authHeaders(adminCookie),
    });
    expect(response.statusCode).toBe(204);
    const detail = await app.inject({ method: 'GET', url: `/api/albums/${albumId}` });
    expect(detail.json().album.people).toHaveLength(0);
  });
});
