---
name: receiving-code-review
description: Use when you receive review findings from a reviewer subagent or the user, before changing code in response. Verify each finding before acting on it.
---

# Receiving code review

A review is a list of claims about the code. Check each claim, then act.

1. **Read** all findings before reacting to any of them.
2. **Restate** each one as a concrete requirement. If you cannot, ask what is meant before changing anything; a half-understood finding leads to a wrong fix.
3. **Verify** it against the code: open the file, follow the call, run the failing case.
4. **Decide:**
   - It is right: fix it, with a test when it is a bug.
   - It is wrong for this codebase: say so with the technical reason and the evidence. Do not implement something you believe is wrong to be agreeable.
   - It asks for more than the task: note it as a follow-up unless the user wants it now.
5. **Fix one finding at a time**, most serious first, and run the checks after each.
6. **Report** per finding: fixed (how), not changed (why), or needs a decision.

## Do not

- Agree before you have checked.
- Apply every suggestion without thinking; a reviewer lacks context too.
- Change code a finding did not mention.
- Fix a finding by weakening a test or hiding an error.
- Thank the reviewer instead of answering the point. The fix is the answer.

The user's review of the diff comes last and overrides a subagent's opinion. When the user's request conflicts with a rule or would break something, say so once and clearly, then do what they decide.
