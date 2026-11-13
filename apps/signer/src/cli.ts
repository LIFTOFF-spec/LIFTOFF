// Emergency pause dari terminal operator (langsung ke DB, tetap bekerja walau signer mati).
//   pnpm --filter @liftoff/signer pause "alasan"
//   pnpm --filter @liftoff/signer resume "alasan"
//   pnpm --filter @liftoff/signer status
// Resume SENGAJA hanya lewat CLI: token worker bisa mem-pause, tetapi tidak bisa me-resume.
import { userInfo } from "node:os";

try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url));
} catch {
  // opsional
}

const { appDatabaseUrl, createPrismaClient } = await import("@liftoff/db");
const { PAUSE_FLAG } = await import("./service");

const [command, ...rest] = process.argv.slice(2);
const reason = rest.join(" ").trim();
const db = createPrismaClient(appDatabaseUrl("signer"));
const actor = `cli:${userInfo().username}`;

try {
  if (command === "pause" || command === "resume") {
    if (reason.length < 3) throw new Error("alasan wajib (min. 3 karakter)");
    const paused = command === "pause";
    await db.systemFlag.upsert({
      where: { key: PAUSE_FLAG },
      create: { key: PAUSE_FLAG, value: { paused, reason }, updatedBy: actor },
      update: { value: { paused, reason }, updatedBy: actor },
    });
    await db.auditEvent.create({
      data: {
        actor,
        action: paused ? "signer.pause" : "signer.resume",
        result: "ok",
        details: { reason },
      },
    });
  } else if (command !== "status") {
    throw new Error("perintah: pause <alasan> | resume <alasan> | status");
  }
  const flag = await db.systemFlag.findUnique({ where: { key: PAUSE_FLAG } });
  console.warn(
    JSON.stringify({
      flag: PAUSE_FLAG,
      value: flag?.value ?? { paused: false },
      envPaused: process.env.SIGNER_PAUSED === "1",
    }),
  );
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
