/** "September 23, 2026" — dates are shown in UTC so server and reader agree. */
export function formatBlogDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}
