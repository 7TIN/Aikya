/**
 * Test isolation: keep the append-only event log out of `artifacts/`.
 *
 * Without this, unit tests that exercise the watcher append synthetic events to
 * the real lab log and skew the dashboard, cost view, and quota usage.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIKYA_EVENT_LOG = join(
  tmpdir(),
  `aikya-test-events-${process.pid}.jsonl`,
);
