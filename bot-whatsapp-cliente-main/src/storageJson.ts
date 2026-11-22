import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

// A corrupt existing file is not an empty database. Refuse to overwrite it.
export function readJsonFile<T>(filePath: string, fallback: () => T, validate?: (value: unknown) => boolean): T {
  let contents: string;
  try {
    contents = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback();
    throw new Error(`Não foi possível ler ${path.basename(filePath)}. Dados preservados.`);
  }
  try {
    const value: unknown = JSON.parse(contents);
    if (validate && !validate(value)) throw new Error("Invalid data");
    return value as T;
  } catch {
    throw new Error(`Arquivo ${path.basename(filePath)} inválido. Restaure um backup antes de gravar novos dados.`);
  }
}

export function readJsonFileWithBackup<T>(filePath: string, fallback: () => T, validate?: (value: unknown) => boolean): T {
  let failure: Error | undefined;
  for (const candidate of [filePath, `${filePath}.bak`]) {
    if (!fs.existsSync(candidate)) continue;
    try { return readJsonFile(candidate, fallback, validate); }
    catch (error) { failure ||= error instanceof Error ? error : new Error(String(error)); }
  }
  if (failure) throw failure;
  return fallback();
}

export function writeJsonAtomic(filePath: string, value: unknown): void {
  const serialized = JSON.stringify(value, null, 2);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, serialized, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, filePath);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

export async function writeJsonAtomicAsync(filePath: string, value: unknown): Promise<void> {
  const serialized = JSON.stringify(value, null, 2);
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(temporary, "wx", 0o600);
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.promises.rename(temporary, filePath);
  } finally {
    if (handle) await handle.close();
    await fs.promises.unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
