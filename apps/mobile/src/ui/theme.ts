/** The Market Runs palette and money formatting, shared by every screen. */

export const colors = {
  ink: "#1B3028",
  muted: "#738078",
  green: "#1C6B49",
  lime: "#D9F26B",
  paper: "#F5F6F0",
  white: "#FFFFFF",
  line: "#E7EAE2",
  orange: "#E88748",
};

/** Integer kobo → "₦1,650" (money never floats in this codebase). */
export const money = (kobo: number) =>
  `₦${(kobo / 100).toLocaleString("en-NG", { maximumFractionDigits: 2 })}`;
