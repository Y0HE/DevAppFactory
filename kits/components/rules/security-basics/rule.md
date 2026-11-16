# Security basics

- Validate all input at the edge of the app; never build SQL, shell commands or HTML by joining strings with user input.
- Keep secrets out of the repository, logs and error messages. Configuration comes from environment variables.
- Authenticate and authorize every endpoint that reads or changes user data; deny by default.
- Add dependencies sparingly, from well-known sources, pinned by the lockfile.
