# TypeScript style

- Keep `strict` on. No `any`; use `unknown` for values you have not checked and narrow them.
- Do not silence the compiler with `as`, `!` or `@ts-ignore`. Fix the type, or check the value at run time.
- Check data from outside the program (requests, files, environment, APIs) at run time with a schema, and derive the type from the schema.
- Model states with discriminated unions instead of several optional fields and booleans.
- Let types be inferred inside functions; write them out on exported functions and public interfaces.
- Use `async`/`await`, and never leave a promise unawaited unless that is deliberate and commented.
- Prefer `const`, `readonly` and immutable updates.
