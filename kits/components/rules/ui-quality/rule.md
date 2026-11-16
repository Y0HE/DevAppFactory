# Interface quality

- Every screen has a designed empty state, loading state and error state, and survives long text and missing data.
- Layouts work from 360 px wide upward without horizontal scrolling; touch targets are at least 44 px.
- Use the project's existing components, spacing scale, colours and type sizes. Do not add one-off values.
- Buttons say what they do ("Save changes", not "OK"). Errors say what happened and what to do next. One thing has one name everywhere.
- Every action gives feedback: pending while it runs, a result when it ends, and no double submission.
- Destructive actions ask for confirmation or can be undone.
- Motion is short, has a purpose, and respects `prefers-reduced-motion`.
