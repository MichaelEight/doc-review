// Stepping through a file's comments in document order. Resolved comments count too; comments whose
// text is gone have no position and come last.

export function commentOrder(items) {
  const placed = items.filter((x) => x.start != null).sort((a, b) => a.start - b.start);
  return [...placed, ...items.filter((x) => x.start == null)];
}

// The comment to go to from `active`, wrapping at both ends. With none active (or an unsaved draft),
// start from where the reader is: viewPos is the source offset at the top of the view.
export function jumpTarget(items, active, delta, viewPos = 0) {
  const list = commentOrder(items);
  if (!list.length) return null;
  const i = list.findIndex((x) => x.id === active);
  if (i >= 0) return list[(i + delta + list.length) % list.length].id;
  if (delta > 0) return (list.find((x) => x.start != null && x.start >= viewPos) ?? list[0]).id;
  return ([...list].reverse().find((x) => x.start != null && x.start < viewPos) ?? list[list.length - 1]).id;
}
