import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { authHeaders, createTestContext, login, multipart, type TestContext } from './helpers.js';

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)));

let context: TestContext;
let app: FastifyInstance;
let adminCookie = '';
let viewerCookie = '';
let albumId = 0;
let coverPhotoId = 0;
let otherPhotoId = 0;
let coverFullUrl = '';
let otherFullUrl = '';

async function uploadPhotoTo(
  cookie: string,
  targetAlbumId: number,
  full: string,
  thumb: string,
  meta: Record<string, unknown>,
): Promise<{ statusCode: number; body: any }> {
  const body = multipart(
    { meta: JSON.stringify(meta) },
    [
      { field: 'full', filename: 'full.avif', contentType: 'image/avif', data: fixture(full) },
      { field: 'thumb', filename: 'thumb.avif', contentType: 'image/avif', data: fixture(thumb) },
    ],
  );
  const response = await app.inject({
    method: 'POST',
    url: `/api/albums/${targetAlbumId}/photos`,
    headers: { ...authHeaders(cookie), ...body.headers },
    payload: body.payload,
  });
  return { statusCode: response.statusCode, body: response.json() };
}

async function uploadPhoto(
  cookie: string,
  full: string,
  thumb: string,
  meta: Record<string, unknown>,
): Promise<{ statusCode: number; body: any }> {
  return uploadPhotoTo(cookie, albumId, full, thumb, meta);
}

beforeAll(async () => {
  context = await createTestContext();
  app = context.app;
});

afterAll(async () => {
  await context.cleanup();
});

describe('API integration', () => {
  it('reports an anonymous session', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/me' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ authenticated: false, user: null, session: null });
  });

  it('rejects a wrong password', async () => {
    const result = await login(app, 'wrong-password-123');
    expect(result.response.statusCode).toBe(401);
    expect(result.response.json().error.code).toBe('INVALID_PASSWORD');
  });

  it('logs in as admin', async () => {
    const result = await login(app, 'admin-password-123');
    expect(result.response.statusCode).toBe(200);
    expect(result.response.json().user.role).toBe('admin');
    expect(result.cookie).toContain('sid=');
    adminCookie = result.cookie;
  });

  it('creates an album', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/albums',
      headers: { ...authHeaders(adminCookie), 'content-type': 'application/json' },
      payload: { name: '集成测试' },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    albumId = body.album.id;
    expect(body.album.name).toBe('集成测试');
    expect(body.album.visibility).toBe('public');
  });

  it('rejects a duplicate album name', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/albums',
      headers: { ...authHeaders(adminCookie), 'content-type': 'application/json' },
      payload: { name: '集成测试' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('ALBUM_NAME_TAKEN');
  });

  it('uploads a photo and makes it the cover', async () => {
    const result = await uploadPhoto(adminCookie, 'sdr.avif', 'thumb.avif', {
      originalName: 'sdr.avif',
      bitDepth: 8,
      isHdr: false,
    });
    expect(result.statusCode).toBe(201);
    expect(result.body.photo.tier).toBe('cover');
    expect(result.body.photo.width).toBe(640);
    expect(result.body.photo.height).toBe(480);
    coverPhotoId = result.body.photo.id;
    coverFullUrl = result.body.photo.fullUrl;
  });

  it('uploads a 10-bit HDR photo as a non-cover', async () => {
    const result = await uploadPhoto(adminCookie, 'hdr.avif', 'thumb.avif', {
      originalName: 'hdr.avif',
      bitDepth: 10,
      isHdr: true,
    });
    expect(result.statusCode).toBe(201);
    expect(result.body.photo.tier).toBe('other');
    expect(result.body.photo.bitDepth).toBe(10);
    expect(result.body.photo.isHdr).toBe(true);
    otherPhotoId = result.body.photo.id;
    otherFullUrl = result.body.photo.fullUrl;
  });

  it('moves a photo into top/ when it becomes the cover', async () => {
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/photos/${otherPhotoId}`,
      headers: { ...authHeaders(adminCookie), 'content-type': 'application/json' },
      payload: { tier: 'cover' },
    });
    expect(patch.statusCode).toBe(200);
    const photo = patch.json().photo;
    expect(photo.tier).toBe('cover');
    expect(photo.fullUrl).toContain('/top/');
    const media = await app.inject({ method: 'GET', url: photo.fullUrl });
    expect(media.statusCode).toBe(200);
    const oldCover = await app.inject({ method: 'GET', url: coverFullUrl });
    expect(oldCover.statusCode).toBe(200);
    // Restore the original cover for the remaining tests.
    const restore = await app.inject({
      method: 'PATCH',
      url: `/api/photos/${coverPhotoId}`,
      headers: { ...authHeaders(adminCookie), 'content-type': 'application/json' },
      payload: { tier: 'cover' },
    });
    expect(restore.statusCode).toBe(200);
  });

  it('deduplicates the same photo in the same album', async () => {
    const result = await uploadPhoto(adminCookie, 'sdr.avif', 'thumb.avif', {
      originalName: 'sdr.avif',
    });
    expect(result.statusCode).toBe(200);
    expect(result.body.deduped).toBe(true);
    expect(result.body.photo.id).toBe(coverPhotoId);
  });

  it('deduplicates by original filename in the same album', async () => {
    const result = await uploadPhoto(adminCookie, 'avatar.avif', 'thumb.avif', {
      originalName: 'sdr.avif',
    });
    expect(result.statusCode).toBe(200);
    expect(result.body.deduped).toBe(true);
    expect(result.body.photo.id).toBe(coverPhotoId);
  });

  it('rejects a thumbnail with the wrong size', async () => {
    const result = await uploadPhoto(adminCookie, 'sdr.avif', 'thumb-wrong.avif', {
      originalName: 'bad-thumb.avif',
    });
    expect(result.statusCode).toBe(422);
    expect(result.body.error.code).toBe('INVALID_THUMBNAIL');
  });

  it('lists the album publicly', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/albums/${albumId}` });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.album.photoCount).toBe(2);
    expect(body.cover.id).toBe(coverPhotoId);
    expect(body.photos.items).toHaveLength(2);
  });

  it('serves public media with immutable caching', async () => {
    const response = await app.inject({ method: 'GET', url: coverFullUrl });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/avif');
    expect(response.headers['cache-control']).toContain('immutable');
    expect(response.rawPayload.byteLength).toBeGreaterThan(100);
    const etag = response.headers.etag;
    expect(etag).toBeTruthy();
    const cached = await app.inject({
      method: 'GET',
      url: coverFullUrl,
      headers: { 'if-none-match': String(etag) },
    });
    expect(cached.statusCode).toBe(304);
  });

  it('creates a viewer user', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: { ...authHeaders(adminCookie), 'content-type': 'application/json' },
      payload: { role: 'viewer', password: 'viewer-password-123' },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().user.role).toBe('viewer');
  });

  it('logs in as the viewer', async () => {
    const result = await login(app, 'viewer-password-123');
    expect(result.response.statusCode).toBe(200);
    viewerCookie = result.cookie;
  });

  it('hides a private album from the public', async () => {
    const before = await app.inject({ method: 'GET', url: coverFullUrl });
    expect(before.statusCode).toBe(200);
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/albums/${albumId}`,
      headers: { ...authHeaders(adminCookie), 'content-type': 'application/json' },
      payload: { visibility: 'private' },
    });
    expect(patch.statusCode).toBe(200);
    const publicResponse = await app.inject({ method: 'GET', url: `/api/albums/${albumId}` });
    expect(publicResponse.statusCode).toBe(404);
    const mediaAfter = await app.inject({ method: 'GET', url: coverFullUrl });
    expect(mediaAfter.statusCode).toBe(404);
    const viewerResponse = await app.inject({
      method: 'GET',
      url: `/api/albums/${albumId}`,
      headers: { cookie: viewerCookie },
    });
    expect(viewerResponse.statusCode).toBe(200);
  });

  it('hides a private photo from the public', async () => {
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/photos/${otherPhotoId}`,
      headers: { ...authHeaders(adminCookie), 'content-type': 'application/json' },
      payload: { visibility: 'private' },
    });
    expect(patch.statusCode).toBe(200);
    const privateUrl = patch.json().photo.fullUrl as string;
    expect(privateUrl).toContain('/hidden/');
    const publicResponse = await app.inject({ method: 'GET', url: privateUrl });
    expect(publicResponse.statusCode).toBe(404);
    const viewerResponse = await app.inject({
      method: 'GET',
      url: privateUrl,
      headers: { cookie: viewerCookie },
    });
    expect(viewerResponse.statusCode).toBe(200);
  });

  it('turns the album private when the last public photo becomes private', async () => {
    const makePublic = await app.inject({
      method: 'PATCH',
      url: `/api/albums/${albumId}`,
      headers: { ...authHeaders(adminCookie), 'content-type': 'application/json' },
      payload: { visibility: 'public' },
    });
    expect(makePublic.statusCode).toBe(200);
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/photos/${coverPhotoId}`,
      headers: { ...authHeaders(adminCookie), 'content-type': 'application/json' },
      payload: { visibility: 'private' },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().photo.visibility).toBe('private');
    expect(patch.json().albumVisibility).toBe('private');
    const publicResponse = await app.inject({ method: 'GET', url: `/api/albums/${albumId}` });
    expect(publicResponse.statusCode).toBe(404);
    const adminResponse = await app.inject({
      method: 'GET',
      url: `/api/albums/${albumId}`,
      headers: { cookie: adminCookie },
    });
    expect(adminResponse.statusCode).toBe(200);
    expect(adminResponse.json().album.visibility).toBe('private');
  });

  it('deletes a photo', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/photos/${otherPhotoId}`,
      headers: authHeaders(adminCookie),
    });
    expect(response.statusCode).toBe(204);
    const list = await app.inject({
      method: 'GET',
      url: `/api/albums/${albumId}/photos`,
      headers: { cookie: adminCookie },
    });
    expect(list.json().items).toHaveLength(1);
  });

  it('protects the last admin', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/admin/users/1',
      headers: authHeaders(adminCookie),
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('LAST_ADMIN');
  });

  it('records audit logs', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/logs?limit=100',
      headers: { cookie: adminCookie },
    });
    expect(response.statusCode).toBe(200);
    const actions = response.json().logs.map((log: { action: string }) => log.action);
    expect(actions).toContain('login.success');
    expect(actions).toContain('album.create');
    expect(actions).toContain('photo.upload');
    expect(actions).toContain('photo.delete');
  });

  it('promotes a featured photo when the cover is deleted', async () => {
    const albumResponse = await app.inject({
      method: 'POST',
      url: '/api/albums',
      headers: { ...authHeaders(adminCookie), 'content-type': 'application/json' },
      payload: { name: '封面提升测试' },
    });
    expect(albumResponse.statusCode).toBe(201);
    const promotionAlbumId = albumResponse.json().album.id as number;
    const first = await uploadPhotoTo(adminCookie, promotionAlbumId, 'sdr.avif', 'thumb.avif', {
      originalName: 'first.avif',
    });
    const second = await uploadPhotoTo(adminCookie, promotionAlbumId, 'hdr.avif', 'thumb.avif', {
      originalName: 'second.avif',
    });
    expect(first.body.photo.tier).toBe('cover');
    expect(second.body.photo.tier).toBe('other');
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/photos/${first.body.photo.id}`,
      headers: authHeaders(adminCookie),
    });
    expect(deleted.statusCode).toBe(204);
    const detail = await app.inject({ method: 'GET', url: `/api/albums/${promotionAlbumId}` });
    expect(detail.statusCode).toBe(200);
    const cover = detail.json().cover;
    expect(cover.id).toBe(second.body.photo.id);
    expect(cover.fullUrl).toContain('/top/');
    const media = await app.inject({ method: 'GET', url: cover.fullUrl });
    expect(media.statusCode).toBe(200);
  });

  it('renames an album and moves its files', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/albums',
      headers: { ...authHeaders(adminCookie), 'content-type': 'application/json' },
      payload: { name: '改名前' },
    });
    expect(created.statusCode).toBe(201);
    const renameAlbumId = created.json().album.id as number;
    const uploaded = await uploadPhotoTo(adminCookie, renameAlbumId, 'sdr.avif', 'thumb.avif', {
      originalName: 'rename.avif',
    });
    expect(uploaded.statusCode).toBe(201);
    const oldFullUrl = uploaded.body.photo.fullUrl as string;

    const renamed = await app.inject({
      method: 'PATCH',
      url: `/api/albums/${renameAlbumId}`,
      headers: { ...authHeaders(adminCookie), 'content-type': 'application/json' },
      payload: { name: '改名后' },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().album.name).toBe('改名后');
    expect(renamed.json().album.dir).toBe('改名后');

    const detail = await app.inject({ method: 'GET', url: `/api/albums/${renameAlbumId}` });
    expect(detail.json().album.name).toBe('改名后');
    const newFullUrl = detail.json().photos.items[0].fullUrl as string;
    expect(newFullUrl).not.toBe(oldFullUrl);
    const media = await app.inject({ method: 'GET', url: newFullUrl });
    expect(media.statusCode).toBe(200);

    const reused = await app.inject({
      method: 'POST',
      url: '/api/albums',
      headers: { ...authHeaders(adminCookie), 'content-type': 'application/json' },
      payload: { name: '改名前' },
    });
    expect(reused.statusCode).toBe(201);
  });

  it('stores and serves a preview image alongside the full image', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/albums',
      headers: { ...authHeaders(adminCookie), 'content-type': 'application/json' },
      payload: { name: '预览图测试' },
    });
    expect(created.statusCode).toBe(201);
    const previewAlbumId = created.json().album.id as number;
    const body = multipart(
      { meta: JSON.stringify({ originalName: 'preview.avif' }) },
      [
        { field: 'full', filename: 'full.avif', contentType: 'image/avif', data: fixture('hdr.avif') },
        { field: 'preview', filename: 'preview.avif', contentType: 'image/avif', data: fixture('sdr.avif') },
        { field: 'thumb', filename: 'thumb.avif', contentType: 'image/avif', data: fixture('thumb.avif') },
      ],
    );
    const uploaded = await app.inject({
      method: 'POST',
      url: `/api/albums/${previewAlbumId}/photos`,
      headers: { ...authHeaders(adminCookie), ...body.headers },
      payload: body.payload,
    });
    expect(uploaded.statusCode).toBe(201);
    const photo = uploaded.json().photo;
    expect(photo.previewUrl).toContain('.preview.avif');
    const preview = await app.inject({ method: 'GET', url: photo.previewUrl });
    expect(preview.statusCode).toBe(200);
    expect(preview.rawPayload.byteLength).toBe(fixture('sdr.avif').byteLength);
    const full = await app.inject({ method: 'GET', url: photo.fullUrl });
    expect(full.statusCode).toBe(200);
    expect(full.rawPayload.byteLength).toBe(fixture('hdr.avif').byteLength);
  });

  it('reports health', async () => {
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    expect(response.json().ok).toBe(true);
  });
});
