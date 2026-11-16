# Docker first

- This server has no app toolchains installed. Run builds, tests, linters and dev servers through `docker compose`, never directly on the host.
- Every service the app needs (database, cache, mail) is a service in `docker-compose.yml`.
- Containers run as a non-root user, without privileged mode and without mounts outside the project folder.
