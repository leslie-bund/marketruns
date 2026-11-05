import { redirect } from "next/navigation";

export default function LegacyInboxPage() {
  redirect("/admin/inbox");
}
