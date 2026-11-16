# Root cause first

- When something fails, find out why before changing code. Read the whole error, reproduce it, and check what changed recently.
- State one hypothesis and test it with the smallest experiment. If it is wrong, undo the experiment before trying the next one.
- Fix the cause, not the place where the symptom shows. Do not add a retry, a default value or a broader `catch` to make a failure go away.
- A fix comes with a test that fails without it.
- After three fixes that did not work, stop and report what you learned. The approach is probably wrong.
