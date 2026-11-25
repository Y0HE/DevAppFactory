import { test } from "node:test";
import assert from "node:assert/strict";
import { EXPECTED_STDERR } from "../dist/runs.js";

test("the untrusted-workspace notice is recognised as expected, other stderr is not", () => {
	assert.ok(EXPECTED_STDERR.test('Ignoring 3 permissions.allow entries from .claude/settings.json: this workspace has not been trusted. Run Claude Code interactively here once and accept the trust dialog, or set projects["/home/x/factory/projects/a"].hasTrustDialogAccepted: true in /home/x/.claude.json.'));
	assert.ok(!EXPECTED_STDERR.test("Error: something else broke"));
});
