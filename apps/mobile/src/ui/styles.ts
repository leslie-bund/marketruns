import { StyleSheet } from "react-native";
import { colors } from "./theme";

/** Shared layout constants. Screens compose these; they rarely write styles. */
export const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.paper },
  page: { paddingHorizontal: 22, paddingTop: 12, paddingBottom: 44, gap: 18 },
  top: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 4 },
  eyebrow: { color: colors.green, fontSize: 11, fontWeight: "800", letterSpacing: 1.6, textTransform: "uppercase", marginBottom: 4 },
  title: { color: colors.ink, fontSize: 29, fontWeight: "800", letterSpacing: -0.7 },
  card: { backgroundColor: colors.white, borderRadius: 20, padding: 17, borderWidth: 1, borderColor: colors.line, gap: 10 },
  section: { gap: 12 },
  sectionHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  sectionTitle: { color: colors.ink, fontSize: 17, fontWeight: "700" },
  label: { color: colors.muted, fontSize: 12, fontWeight: "700", marginBottom: 3 },
  body: { color: colors.ink, fontSize: 14, lineHeight: 21 },
  muted: { color: colors.muted, fontSize: 12 },
  input: { minHeight: 50, borderColor: colors.line, borderWidth: 1, borderRadius: 13, paddingHorizontal: 14, color: colors.ink, backgroundColor: colors.white, fontSize: 15 },
  button: { minHeight: 49, backgroundColor: colors.green, borderRadius: 14, justifyContent: "center", alignItems: "center", paddingHorizontal: 18 },
  buttonSecondary: { backgroundColor: "#EDF3EE", borderWidth: 1, borderColor: "#D9E5DD" },
  buttonDanger: { backgroundColor: colors.orange },
  buttonDangerSecondary: { backgroundColor: "#FBEEE3", borderColor: "#F2C9AC" },
  buttonText: { color: colors.white, fontWeight: "800", fontSize: 14 },
  buttonTextSecondary: { color: colors.green },
  buttonDangerTextSecondary: { color: colors.orange },
  pill: { borderRadius: 99, paddingHorizontal: 11, paddingVertical: 6, backgroundColor: "#F0F2EE", alignSelf: "flex-start" },
  pillActive: { backgroundColor: "#E6F3EA" },
  pillText: { fontSize: 11, color: colors.muted, fontWeight: "700" },
  pillTextActive: { color: colors.green },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12 },
  divider: { height: 1, backgroundColor: colors.line, marginVertical: 4 },
});
