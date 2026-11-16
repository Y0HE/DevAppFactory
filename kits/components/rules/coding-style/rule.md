# Coding style

- Write the simplest code that does the job. Clear beats clever, and code that is not needed yet is not written.
- Name things for what they are or do. A reader should not need the comment to understand the name.
- Keep functions short and files focused on one responsibility. Split a file when it does several unrelated things, and organise by feature rather than by technical type.
- Prefer returning new values to changing shared ones; keep side effects at the edges.
- Return early instead of nesting deeply. No magic numbers; give constants a name.
- Comments explain why, never what. Delete commented-out code and unused code.
- Match the style of the surrounding code and let the project's formatter and linter decide the rest.
