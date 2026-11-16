---
name: frontend-design
description: Use when building a new page or component or reshaping an existing interface. Guides deliberate choices in layout, type, colour and states so the result does not look like a default template.
---

# Frontend design

Design for this product and its users, not for a generic app. Every visual choice should have a reason you can say in a sentence.

## Before writing markup

1. Name the screen's one job and its primary action. Everything else is secondary and looks secondary.
2. Look at what exists: components, spacing scale, colours, type sizes, tokens. Extend the system; do not start a second one beside it.
3. Write the real content first: headings, labels, button text, an example of real data, including the longest and the empty case. Layouts designed around placeholder text break on real text.

## Layout

- Build hierarchy with size, weight and space before reaching for boxes, borders and colour.
- Use one spacing scale. Related things sit close together; unrelated things get clear distance.
- Align to a small number of edges. Keep text lines under about 75 characters.
- Design the narrow screen first, then let wide screens use the room.

## Type and colour

- One typeface, two at most. A small set of sizes with clear steps between them.
- One accent colour with a job (the primary action, the current item). Greys carry the rest.
- Text contrast of at least 4.5 to 1, in light and dark mode when both exist.

## States

Every component is designed in each state it can be in: default, hover, focus, active, disabled, loading, empty, error, and with too much content.

## Avoid the template look

These are defaults, not choices. Use one only when the content calls for it:

- Every section as an identical rounded card with the same soft shadow.
- Gradient backgrounds and glow as decoration.
- A small all-caps label above every heading.
- One word of the headline in another colour.
- Fade-and-slide animation on everything that enters the screen.
- Icons or emoji in front of every list item.

## Check before finishing

- Squint: is the primary action the most visible thing?
- Tab through it: is everything reachable and the focus visible?
- Narrow it to 360 px, then fill it with long text and with no data.
- Compare it with a neighbouring screen: same spacing, same components, same words for the same things?
