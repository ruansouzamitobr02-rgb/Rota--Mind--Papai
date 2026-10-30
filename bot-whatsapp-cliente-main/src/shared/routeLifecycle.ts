import type { RouteDispatch } from "./types";

export function isRouteDeleted(route: RouteDispatch) {
  return route.decisionStatus === "deleted" || Boolean(route.deletedAt || route.deletedMessageIds?.length || route.deletionEvents?.length || route.clientIncident?.kind === "message_deleted");
}

export function getRouteDecisionStatus(route: RouteDispatch): NonNullable<RouteDispatch["decisionStatus"]> {
  return isRouteDeleted(route) ? "deleted" : route.decisionStatus || (route.validated ? "validated" : "pending");
}

export function routeDeletedAt(route: RouteDispatch) {
  return route.deletedAt || route.deletionEvents?.[0]?.detectedAt || route.clientIncident?.createdAt || route.updatedAt;
}
