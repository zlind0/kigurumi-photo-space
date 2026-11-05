import { loadConfig } from '../server/config.js';
import { openDatabase } from '../server/db/index.js';
import { generatePassword, hashPassword, passwordLookup, validatePassword } from '../server/auth/password.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = openDatabase(config);
  const argPassword = process.argv[2] ?? process.env.ADMIN_PASSWORD;
  let password: string;
  let generated = false;
  if (argPassword) {
    password = validatePassword(argPassword);
  } else {
    password = generatePassword();
    generated = true;
  }
  const lookup = passwordLookup(config.authPepper, password);
  const existing = db.get<{ id: number }>('SELECT id FROM users WHERE password_lookup = ?', lookup);
  if (existing) {
    console.error('该密码已被使用，请换一个密码。');
    db.close();
    process.exit(1);
  }
  const hash = await hashPassword(password);
  const result = db.run(
    `INSERT INTO users (role, password_lookup, password_hash, created_at, note)
     VALUES ('admin', ?, ?, ?, 'created by CLI')`,
    lookup,
    hash,
    Date.now(),
  );
  console.log(`已创建管理员 #${result.lastInsertRowid}`);
  if (generated) {
    console.log(`密码（只显示一次）：${password}`);
  }
  db.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
