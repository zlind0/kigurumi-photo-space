import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import type { Database } from '../db/index.js';
import { assertSameOrigin } from '../http/csrf.js';
import { badRequest, forbidden, notFound, tooLarge, unauthorized, unprocessable } from '../http/errors.js';
import { getAlbumById } from '../services/albums.js';
import { validateAvifFile } from '../services/avif-validate.js';
import {
  createPerson,
  deletePerson,
  getPersonById,
  listPeople,
  parseAccent,
  personToDTO,
  setAlbumPeople,
  updatePerson,
} from '../services/people.js';
import { createTempFile } from '../services/storage.js';

interface UploadedAvatar {
  path: string;
  md5: string;
}

interface PersonForm {
  name?: string;
  hue?: string;
  saturation?: string;
  lightness?: string;
  avatar: UploadedAvatar | null;
  tempPaths: string[];
}

function requireAdmin(role: string): void {
  if (role !== 'admin') throw forbidden('需要管理员权限');
}

function parseId(raw: string): number {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) throw notFound('人物不存在');
  return id;
}

async function readPersonForm(
  request: FastifyRequest,
  config: Config,
): Promise<PersonForm> {
  const form: PersonForm = { avatar: null, tempPaths: [] };
  if (!request.isMultipart()) {
    const body = request.body as Record<string, unknown> | null;
    if (body) {
      if (typeof body.name === 'string') form.name = body.name;
      if (body.hue !== undefined) form.hue = String(body.hue);
      if (body.saturation !== undefined) form.saturation = String(body.saturation);
      if (body.lightness !== undefined) form.lightness = String(body.lightness);
    }
    return form;
  }
  for await (const part of request.parts()) {
    if (part.type === 'field') {
      if (part.fieldname === 'name' && typeof part.value === 'string') form.name = part.value;
      if (part.fieldname === 'hue' && typeof part.value === 'string') form.hue = part.value;
      if (part.fieldname === 'saturation' && typeof part.value === 'string') form.saturation = part.value;
      if (part.fieldname === 'lightness' && typeof part.value === 'string') form.lightness = part.value;
      continue;
    }
    if (part.fieldname !== 'avatar') {
      part.file.resume();
      continue;
    }
    if (form.avatar) throw badRequest('重复的头像文件');
    const temp = await createTempFile(config);
    form.tempPaths.push(temp.path);
    const hash = createHash('md5');
    let size = 0;
    try {
      for await (const chunk of part.file) {
        const buffer = chunk as Buffer;
        size += buffer.byteLength;
        if (size > config.maxThumbBytes) throw tooLarge('头像文件过大');
        hash.update(buffer);
        await temp.handle.write(buffer);
      }
    } finally {
      await temp.handle.close();
    }
    if (part.file.truncated) throw tooLarge('头像文件过大');
    form.avatar = { path: temp.path, md5: hash.digest('hex') };
  }
  return form;
}

async function validateAvatar(form: PersonForm, config: Config): Promise<void> {
  if (!form.avatar) return;
  const info = await validateAvifFile(form.avatar.path, 'full', config);
  if (info.width !== 200 || info.height !== 200) {
    throw unprocessable('INVALID_AVATAR', '头像必须是 200×200 的 AVIF');
  }
}

export function registerPeopleRoutes(app: FastifyInstance, db: Database, config: Config): void {
  app.get('/api/people', async (_request, reply) => {
    reply.header('cache-control', 'private, no-store');
    return { people: listPeople(db).map(personToDTO) };
  });

  app.post('/api/admin/people', async (request, reply) => {
    assertSameOrigin(request, config);
    requireAdmin(request.role);
    if (!request.auth) throw unauthorized();
    const form = await readPersonForm(request, config);
    try {
      if (!form.avatar) throw badRequest('请上传人物头像');
      await validateAvatar(form, config);
      const person = await createPerson(db, config, {
        name: form.name,
        accent: parseAccent(form),
        avatarTmpPath: form.avatar.path,
        avatarMd5: form.avatar.md5,
        userId: request.auth.user.id,
        sessionId: request.auth.session.id,
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });
      reply.code(201).header('cache-control', 'private, no-store');
      return { person: personToDTO(person) };
    } finally {
      for (const path of form.tempPaths) {
        await rm(path, { force: true }).catch(() => undefined);
      }
    }
  });

  app.patch('/api/admin/people/:id', async (request, reply) => {
    assertSameOrigin(request, config);
    requireAdmin(request.role);
    if (!request.auth) throw unauthorized();
    const { id } = request.params as { id: string };
    const person = getPersonById(db, parseId(id));
    if (!person) throw notFound('人物不存在');
    const form = await readPersonForm(request, config);
    try {
      await validateAvatar(form, config);
      const updated = await updatePerson(db, config, {
        person,
        name: form.name,
        accent:
          form.hue !== undefined || form.saturation !== undefined || form.lightness !== undefined
            ? parseAccent(form)
            : undefined,
        avatarTmpPath: form.avatar?.path,
        avatarMd5: form.avatar?.md5,
        userId: request.auth.user.id,
        sessionId: request.auth.session.id,
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });
      reply.header('cache-control', 'private, no-store');
      return { person: personToDTO(updated) };
    } finally {
      for (const path of form.tempPaths) {
        await rm(path, { force: true }).catch(() => undefined);
      }
    }
  });

  app.delete('/api/admin/people/:id', async (request, reply) => {
    assertSameOrigin(request, config);
    requireAdmin(request.role);
    if (!request.auth) throw unauthorized();
    const { id } = request.params as { id: string };
    const person = getPersonById(db, parseId(id));
    if (!person) throw notFound('人物不存在');
    await deletePerson(db, config, {
      person,
      userId: request.auth.user.id,
      sessionId: request.auth.session.id,
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
    });
    reply.code(204).send();
  });

  app.put('/api/albums/:id/people', async (request, reply) => {
    assertSameOrigin(request, config);
    requireAdmin(request.role);
    if (!request.auth) throw unauthorized();
    const { id } = request.params as { id: string };
    const albumId = Number(id);
    if (!Number.isSafeInteger(albumId) || albumId <= 0) throw notFound('相册不存在');
    const album = getAlbumById(db, albumId);
    if (!album) throw notFound('相册不存在');
    const body = request.body as { personIds?: unknown } | null;
    const people = setAlbumPeople(db, {
      albumId,
      personIds: body?.personIds,
      userId: request.auth.user.id,
      sessionId: request.auth.session.id,
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
    });
    reply.header('cache-control', 'private, no-store');
    return { people: people.map(personToDTO) };
  });
}
