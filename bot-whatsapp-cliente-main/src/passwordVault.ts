import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import fs from "fs";
import path from "path";

/** Kept in DATA_DIR so encrypted backups preserve access after a migration. */
export class PasswordVault {
  private readonly keyPath: string;
  constructor(usersPath: string) { this.keyPath = path.join(path.dirname(usersPath), ".panel-password-key"); }

  seal(password: string, email: string): string {
    fs.mkdirSync(path.dirname(this.keyPath), { recursive: true });
    if (!fs.existsSync(this.keyPath)) {
      try { fs.writeFileSync(this.keyPath, randomBytes(32), { flag: "wx", mode: 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    const key = fs.readFileSync(this.keyPath);
    if (key.length !== 32) throw new Error("Chave do cofre de senhas inválida.");
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(email));
    const encrypted = Buffer.concat([cipher.update(password, "utf8"), cipher.final()]);
    return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), encrypted.toString("base64")].join(":");
  }

  open(value: string | undefined, email: string): string | undefined {
    if (!value) return undefined;
    try {
      const [version, iv, tag, encrypted] = value.split(":");
      if (version !== "v1") return undefined;
      const decipher = createDecipheriv("aes-256-gcm", fs.readFileSync(this.keyPath), Buffer.from(iv, "base64"));
      decipher.setAAD(Buffer.from(email));
      decipher.setAuthTag(Buffer.from(tag, "base64"));
      return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64")), decipher.final()]).toString("utf8");
    } catch { return undefined; }
  }
}
