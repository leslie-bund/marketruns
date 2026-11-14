import { useOutletContext } from "react-router";
import type { OpsUser } from "./ops-api";

export function useOpsUser(): OpsUser {
  return useOutletContext<OpsUser>();
}
