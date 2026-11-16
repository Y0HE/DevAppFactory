# Error handling

- Never swallow an error. No empty `catch`, no ignored promise, no ignored exit code.
- Do not hide a failure behind a default. Returning `null`, an empty list or a cached value when the real operation failed makes "nothing" and "broken" look the same.
- Handle an error where something useful can be done about it; otherwise let it travel up with its cause attached.
- Validate at the edge of the app (user input, external APIs, files). Trust the code inside; do not add checks for cases that cannot happen.
- The user gets a message that says what happened and what to do next. The log gets the detail and the context. Neither gets secrets.
- Calls to a network or a database have a timeout, and multi-step writes are in a transaction or have a way back.
