// Global test setup (vitest setupFiles — runs before every test file's
// modules are imported). ONE job: redirect the tombstone sidecar away from
// the real ~/.pi/agent so store deletes during tests (which schedule
// best-effort flushes) never touch the developer's actual state.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTombstonePath } from "../src/tombstones.js";

setTombstonePath(join(tmpdir(), `pi-ch-tombstones-test-${process.pid}.json`));
