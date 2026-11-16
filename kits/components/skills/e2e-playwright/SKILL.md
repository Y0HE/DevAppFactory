---
name: e2e-playwright
description: Use when a feature needs a browser test of a user journey, or when verifying a web interface end to end. Covers running Playwright in Docker Compose and writing tests that do not flake.
---

# End-to-end tests with Playwright

Browser tests prove that a user journey works through the real interface. Keep them few: one per journey that matters, not one per component.

## Running in this project

The server has no browsers installed. Playwright runs as a Compose service, next to the app:

```yaml
  e2e:
    image: mcr.microsoft.com/playwright:v1.49.0-jammy   # same version as @playwright/test in the lockfile
    profiles: [test]
    working_dir: /work
    volumes: [".:/work"]
    environment:
      BASE_URL: http://app:3000
    depends_on: [app]
    command: npx playwright test
```

- Run with `docker compose run --rm e2e`. Add it to the project's checks only after the user agrees, because checks live in `.factory/project.yml`, which agents do not edit.
- Use the service name (`http://app:3000`) as base URL, never `localhost`.
- Keep the image tag and the `@playwright/test` version identical.

## Writing tests

- Find elements the way a user does: `getByRole`, `getByLabel`, `getByText`. Use test ids only when nothing else fits. No CSS or XPath selectors tied to styling.
- Never wait a fixed time. Assert with `await expect(locator).toBeVisible()` and similar; these retry until the condition holds.
- Each test creates the data it needs and does not depend on another test or on the order.
- One journey per test, named for what the user achieves: "a visitor can sign up and reach the dashboard".
- Cover the failure the user can cause: wrong password, empty required field.

## When a test fails

1. Read the error and the trace first: set `trace: 'retain-on-failure'` and `screenshot: 'only-on-failure'` in the Playwright config.
2. Check that the app is healthy from inside the `e2e` container before suspecting the test.
3. A test that fails sometimes has a missing wait or shared data. Find it; do not add a retry or a sleep.

## Exploring an unknown page

Before writing selectors, load the page once, take a screenshot and print the accessibility tree, then choose locators from what is really rendered.
