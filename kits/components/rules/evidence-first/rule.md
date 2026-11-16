# Evidence first

- Never say that something works, passes or is fixed unless you ran the command that proves it after your last change and read its output.
- "Should work", "probably" and "looks right" mean you have not verified. Verify, or say that you did not.
- A bug is fixed when the original failing case now passes, not when the code was changed.
- Passing tests do not prove the task is done. Check each acceptance criterion against the code or the running app.
- Do not trust a subagent's report of success. Look at the diff and run the checks yourself.
- End your work with what you verified and how, and what you could not verify.
