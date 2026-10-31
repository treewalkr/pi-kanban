import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const script = join(root, "scripts", "repro.sh");

interface ReproResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function repro(env: Record<string, string>): Promise<ReproResult> {
  const proc = Bun.spawn(["bash", script], {
    cwd: root,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    // a regression must fail loudly (exit 143), never hang the suite. 85s stays under
    // the pin test's 90s budget: under the pre-review gate the suite shares CPU with
    // live builder sessions and the boot+TTL-reap path can take well over 30s
    signal: AbortSignal.timeout(85_000),
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

describe("repro.sh REPRO_PORT guard", () => {
  test("rejects pins below 4611 and non-numeric pins before any setup", async () => {
    const badPins: Array<[string, RegExp]> = [
      ["4600", /REPRO_PORT must be >= 4611 \(4600 is production\) — got 4600/],
      ["80", /REPRO_PORT must be >= 4611 \(4600 is production\) — got 80/],
      ["abc", /REPRO_PORT must be a number — got 'abc'/],
    ];
    for (const [pin, message] of badPins) {
      const r = await repro({ REPRO_PORT: pin });
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(message);
      expect(r.stdout).toBe(""); // banner (line 51) never printed → no mktemp/pidfile/spawn
    }
  });

  test("accepts a valid pin and boots on it (TTL reaps)", async () => {
    const r = await repro({ REPRO_PORT: "4615", REPRO_TTL: "2" });
    expect(r.stdout).toContain("repro board → http://127.0.0.1:4615");
    expect(r.stderr).not.toContain("REPRO_PORT must be");
    expect(r.code).toBe(0);
  }, 90_000); // boots a real server + waits out the TTL reap — starved under gate-load (builders share CPU), 30s proved too tight

  test("no REPRO_PORT still scans 4611-4620", async () => {
    const r = await repro({ REPRO_PORT: "", REPRO_TTL: "2" }); // empty ⇒ scan
    expect(r.stdout).toMatch(/repro board → http:\/\/127\.0\.0\.1:(461[1-9]|4620)/);
    expect(r.stderr).not.toContain("REPRO_PORT must be");
    expect(r.code).toBe(0);
  });
});
