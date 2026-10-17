import { randomBytes, scryptSync } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("../", import.meta.url));
const dataDir = process.env.DATA_DIR || join(appRoot, "data");
mkdirSync(dataDir, { recursive: true });
const database = new DatabaseSync(
  process.env.DATABASE_PATH || join(dataDir, "escape-villa.sqlite3"),
);
const prompt = createInterface({ input: stdin, output: stdout });

const main = async (): Promise<void> => {
  database.exec("BEGIN IMMEDIATE");
  try {
    const adminCount = Number(
      database
        .prepare("SELECT COUNT(*) AS count FROM users WHERE role='admin'")
        .get()?.count,
    );
    if (adminCount > 0) {
      throw new Error(
        "An administrator already exists. Sign in at /admin/login instead.",
      );
    }

    const name = (await prompt.question("Administrator full name: ")).trim();
    const email = (await prompt.question("Administrator email: "))
      .trim()
      .toLowerCase();
    const password = await prompt.question(
      "Choose an administrator password (at least 10 characters): ",
    );

    if (!name || !/^\S+@\S+\.\S+$/.test(email) || password.length < 10) {
      throw new Error(
        "Enter a name, a valid email address, and a password of at least 10 characters.",
      );
    }

    const salt = randomBytes(16).toString("hex");
    const passwordHash = `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
    database
      .prepare(
        "INSERT INTO users(name,email,password_hash,role,created_at) VALUES(?,?,?,'admin',?)",
      )
      .run(name, email, passwordHash, new Date().toISOString());
    database.exec("COMMIT");
    console.log("Administrator account created. Sign in at /admin/login.");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
};

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Admin setup failed.");
  process.exitCode = 1;
} finally {
  prompt.close();
  database.close();
}
