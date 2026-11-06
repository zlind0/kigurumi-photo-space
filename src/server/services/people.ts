import { rm } from 'node:fs/promises';
import type { Config } from '../config.js';
import type { Database } from '../db/index.js';
import type { PersonDTO } from '../../shared/types.js';
import { badRequest, conflict, notFound } from '../http/errors.js';
import { audit } from './audit.js';
import { personAvatarPath, placeFile } from './storage.js';

export interface PersonRow {
  id: number;
  name: string;
  accent_hue: number;
  accent_saturation: number;
  accent_lightness: number;
  avatar_md5: string;
  created_at: number;
  created_by: number | null;
}

export interface AccentInput {
  hue: number;
  saturation: number;
  lightness: number;
}

export const DEFAULT_ACCENT: AccentInput = { hue: 330, saturation: 70, lightness: 80 };

export function personToDTO(row: PersonRow): PersonDTO {
  return {
    id: row.id,
    name: row.name,
    accent: `hsl(${row.accent_hue} ${row.accent_saturation}% ${row.accent_lightness}%)`,
    hue: row.accent_hue,
    saturation: row.accent_saturation,
    lightness: row.accent_lightness,
    avatarUrl: `/p/${row.avatar_md5}.avif`,
    createdAt: row.created_at,
  };
}

export function listPeople(db: Database): PersonRow[] {
  return db.all<PersonRow>('SELECT * FROM people ORDER BY created_at ASC, id ASC');
}

export function getPersonById(db: Database, id: number): PersonRow | null {
  return db.get<PersonRow>('SELECT * FROM people WHERE id = ?', id) ?? null;
}

export function listPeopleForAlbum(db: Database, albumId: number): PersonRow[] {
  return db.all<PersonRow>(
    `SELECT p.* FROM people p
     JOIN album_people ap ON ap.person_id = p.id
     WHERE ap.album_id = ?
     ORDER BY p.created_at ASC, p.id ASC`,
    albumId,
  );
}

export function listPeopleForAlbums(db: Database, albumIds: number[]): Map<number, PersonRow[]> {
  const result = new Map<number, PersonRow[]>();
  if (albumIds.length === 0) return result;
  const placeholders = albumIds.map(() => '?').join(',');
  const rows = db.all<PersonRow & { album_id: number }>(
    `SELECT p.*, ap.album_id FROM people p
     JOIN album_people ap ON ap.person_id = p.id
     WHERE ap.album_id IN (${placeholders})
     ORDER BY p.created_at ASC, p.id ASC`,
    ...albumIds,
  );
  for (const row of rows) {
    const list = result.get(row.album_id) ?? [];
    list.push(row);
    result.set(row.album_id, list);
  }
  return result;
}

export function sanitizePersonName(raw: unknown, maxLength = 40): string {
  if (typeof raw !== 'string') throw badRequest('人物名必须是字符串');
  const name = raw
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  if (!name) throw badRequest('人物名不能为空');
  if ([...name].length > maxLength) throw badRequest(`人物名不能超过 ${maxLength} 个字符`);
  return name;
}

function clampInt(raw: unknown, min: number, max: number, fallback: number, label: string): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw badRequest(`${label}必须是数字`);
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function parseAccent(input: {
  hue?: unknown;
  saturation?: unknown;
  lightness?: unknown;
}): AccentInput {
  return {
    hue: clampInt(input.hue, 0, 360, DEFAULT_ACCENT.hue, '色相'),
    saturation: clampInt(input.saturation, 0, 100, DEFAULT_ACCENT.saturation, '饱和度'),
    lightness: clampInt(input.lightness, 0, 100, DEFAULT_ACCENT.lightness, '亮度'),
  };
}

export interface PersonMutationContext {
  userId: number;
  sessionId: string;
  ip: string | null;
  userAgent: string | null;
}

export interface CreatePersonInput extends PersonMutationContext {
  name: unknown;
  accent: AccentInput;
  avatarTmpPath: string;
  avatarMd5: string;
}

export async function createPerson(
  db: Database,
  config: Config,
  input: CreatePersonInput,
): Promise<PersonRow> {
  const name = sanitizePersonName(input.name);
  const duplicate = db.get<{ id: number }>('SELECT id FROM people WHERE name = ?', name);
  if (duplicate) throw conflict('PERSON_NAME_TAKEN', '人物名已存在');
  const target = personAvatarPath(config, input.avatarMd5);
  await placeFile(config, input.avatarTmpPath, target, null);
  const result = db.run(
    `INSERT INTO people
      (name, accent_hue, accent_saturation, accent_lightness, avatar_md5, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    name,
    input.accent.hue,
    input.accent.saturation,
    input.accent.lightness,
    input.avatarMd5,
    Date.now(),
    input.userId,
  );
  const person = getPersonById(db, result.lastInsertRowid);
  if (!person) throw new Error('创建人物失败');
  audit(db, {
    userId: input.userId,
    sessionId: input.sessionId,
    action: 'person.create',
    ip: input.ip,
    userAgent: input.userAgent,
    targetType: 'person',
    targetId: person.id,
    detail: { name: person.name, accent: input.accent },
  });
  return person;
}

export interface UpdatePersonInput extends PersonMutationContext {
  person: PersonRow;
  name?: unknown;
  accent?: AccentInput;
  avatarTmpPath?: string;
  avatarMd5?: string;
}

export async function updatePerson(
  db: Database,
  config: Config,
  input: UpdatePersonInput,
): Promise<PersonRow> {
  const name = input.name === undefined ? input.person.name : sanitizePersonName(input.name);
  if (name !== input.person.name) {
    const duplicate = db.get<{ id: number }>('SELECT id FROM people WHERE name = ? AND id != ?', name, input.person.id);
    if (duplicate) throw conflict('PERSON_NAME_TAKEN', '人物名已存在');
  }
  const accent = input.accent ?? {
    hue: input.person.accent_hue,
    saturation: input.person.accent_saturation,
    lightness: input.person.accent_lightness,
  };
  let avatarMd5 = input.person.avatar_md5;
  if (input.avatarTmpPath && input.avatarMd5) {
    await placeFile(config, input.avatarTmpPath, personAvatarPath(config, input.avatarMd5), null);
    avatarMd5 = input.avatarMd5;
  }
  db.run(
    `UPDATE people
     SET name = ?, accent_hue = ?, accent_saturation = ?, accent_lightness = ?, avatar_md5 = ?
     WHERE id = ?`,
    name,
    accent.hue,
    accent.saturation,
    accent.lightness,
    avatarMd5,
    input.person.id,
  );
  const updated = getPersonById(db, input.person.id);
  if (!updated) throw notFound('人物不存在');
  if (avatarMd5 !== input.person.avatar_md5) {
    await removeAvatarIfUnused(db, config, input.person.avatar_md5);
  }
  audit(db, {
    userId: input.userId,
    sessionId: input.sessionId,
    action: 'person.update',
    ip: input.ip,
    userAgent: input.userAgent,
    targetType: 'person',
    targetId: updated.id,
    detail: { name: updated.name, accent },
  });
  return updated;
}

export async function deletePerson(
  db: Database,
  config: Config,
  input: PersonMutationContext & { person: PersonRow },
): Promise<void> {
  db.run('DELETE FROM people WHERE id = ?', input.person.id);
  await removeAvatarIfUnused(db, config, input.person.avatar_md5);
  audit(db, {
    userId: input.userId,
    sessionId: input.sessionId,
    action: 'person.delete',
    ip: input.ip,
    userAgent: input.userAgent,
    targetType: 'person',
    targetId: input.person.id,
    detail: { name: input.person.name },
  });
}

async function removeAvatarIfUnused(db: Database, config: Config, md5: string): Promise<void> {
  const used = db.get<{ c: number }>('SELECT COUNT(*) AS c FROM people WHERE avatar_md5 = ?', md5);
  if ((used?.c ?? 0) > 0) return;
  await rm(personAvatarPath(config, md5), { force: true }).catch(() => undefined);
}

export function setAlbumPeople(
  db: Database,
  input: PersonMutationContext & { albumId: number; personIds: unknown },
): PersonRow[] {
  if (!Array.isArray(input.personIds)) throw badRequest('personIds 必须是数组');
  const ids = Array.from(
    new Set(
      input.personIds.map((value) => {
        const id = Number(value);
        if (!Number.isSafeInteger(id) || id <= 0) throw badRequest('personIds 包含无效 ID');
        return id;
      }),
    ),
  );
  if (ids.length > 0) {
    const placeholders = ids.map(() => '?').join(',');
    const found = db.all<{ id: number }>(`SELECT id FROM people WHERE id IN (${placeholders})`, ...ids);
    if (found.length !== ids.length) throw badRequest('包含不存在的人物');
  }
  db.transaction(() => {
    db.run('DELETE FROM album_people WHERE album_id = ?', input.albumId);
    const now = Date.now();
    for (const personId of ids) {
      db.run(
        'INSERT INTO album_people (album_id, person_id, created_at) VALUES (?, ?, ?)',
        input.albumId,
        personId,
        now,
      );
    }
  });
  audit(db, {
    userId: input.userId,
    sessionId: input.sessionId,
    action: 'album.people',
    ip: input.ip,
    userAgent: input.userAgent,
    targetType: 'album',
    targetId: input.albumId,
    detail: { personIds: ids },
  });
  return listPeopleForAlbum(db, input.albumId);
}
