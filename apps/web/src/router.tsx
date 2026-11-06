import { Link, Outlet, createRootRoute, createRoute, createRouter, lazyRouteComponent, redirect, useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { Alert, Button, Spinner } from "./components/ui";
import { errorMessage } from "./lib/api";
import { reportError } from "./lib/sentry";
import { ForgotPage, InvitePage, LoginPage, ResetPage } from "./pages/public";

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

const root = createRootRoute({
  component: Outlet,
  notFoundComponent: () => (
    <main className="mx-auto max-w-md px-4 py-16 text-center">
      <h1 className="mb-2 text-xl font-semibold">Page not found</h1>
      <Link to="/login" className="link">
        Go to sign in
      </Link>
    </main>
  ),
});

// Public client auth
const index = createRoute({ getParentRoute: () => root, path: "/", beforeLoad: () => { throw redirect({ to: "/login" }); } });
const login = createRoute({ getParentRoute: () => root, path: "login", component: LoginPage });
const forgot = createRoute({ getParentRoute: () => root, path: "forgot", component: ForgotPage });
const reset = createRoute({ getParentRoute: () => root, path: "reset/$token", component: ResetPage });
const invite = createRoute({ getParentRoute: () => root, path: "invite/$token", component: InvitePage });

// Client portal (own chunk)
const P = <K extends keyof typeof import("./pages/portal")>(name: K) => lazyRouteComponent(() => import("./pages/portal"), name);
const portal = createRoute({ getParentRoute: () => root, path: "portal", component: P("PortalShell") });
const portalChildren = [
  createRoute({ getParentRoute: () => portal, path: "/", component: P("PortalHome") }),
  createRoute({ getParentRoute: () => portal, path: "documents", component: P("PortalDocuments") }),
  createRoute({ getParentRoute: () => portal, path: "reports", component: P("PortalReports") }),
  createRoute({ getParentRoute: () => portal, path: "letters", component: P("PortalLetters") }),
  createRoute({ getParentRoute: () => portal, path: "settings", component: P("PortalSettings") }),
];

// Staff (Access-authenticated; admin-only pages are separate chunks)
const admin = createRoute({ getParentRoute: () => root, path: "admin", component: lazyRouteComponent(() => import("./pages/admin/shell"), "AdminShell") });
const A = {
  shell: <K extends keyof typeof import("./pages/admin/shell")>(n: K) => lazyRouteComponent(() => import("./pages/admin/shell"), n),
  clients: <K extends keyof typeof import("./pages/admin/clients")>(n: K) => lazyRouteComponent(() => import("./pages/admin/clients"), n),
  letters: <K extends keyof typeof import("./pages/admin/letters")>(n: K) => lazyRouteComponent(() => import("./pages/admin/letters"), n),
  settings: <K extends keyof typeof import("./pages/admin/settings")>(n: K) => lazyRouteComponent(() => import("./pages/admin/settings"), n),
};
const adminChildren = [
  createRoute({ getParentRoute: () => admin, path: "/", component: A.shell("Dashboard") }),
  createRoute({ getParentRoute: () => admin, path: "tasks", component: A.shell("TasksPage") }),
  createRoute({ getParentRoute: () => admin, path: "clients", component: A.clients("ClientsPage") }),
  createRoute({ getParentRoute: () => admin, path: "clients/new", component: A.clients("ClientCreatePage") }),
  createRoute({ getParentRoute: () => admin, path: "clients/$clientId", component: A.clients("ClientDetailPage"), validateSearch: (s: Record<string, unknown>): { tab?: string } => ({ tab: str(s.tab) }) }),
  createRoute({ getParentRoute: () => admin, path: "letters", component: A.letters("LettersQueuePage"), validateSearch: (s: Record<string, unknown>): { status?: string } => ({ status: str(s.status) }) }),
  createRoute({ getParentRoute: () => admin, path: "letters/$letterId", component: A.letters("LetterDetailPage") }),
  createRoute({ getParentRoute: () => admin, path: "users", component: A.settings("UsersPage") }),
  createRoute({ getParentRoute: () => admin, path: "org", component: A.settings("OrgSettingsPage") }),
  createRoute({ getParentRoute: () => admin, path: "templates", component: A.settings("TemplatesPage") }),
  createRoute({ getParentRoute: () => admin, path: "templates/$templateId", component: A.settings("TemplateEditPage") }),
  createRoute({ getParentRoute: () => admin, path: "rules", component: A.settings("FlagRulesPage") }),
  createRoute({ getParentRoute: () => admin, path: "audit", component: A.settings("AuditPage") }),
];

function RouteError({ error }: { error: unknown }) {
  const router = useRouter();
  useEffect(() => void reportError(error), [error]);
  return (
    <div className="mx-auto max-w-lg space-y-3 px-4 py-10">
      <Alert title="Something went wrong">{errorMessage(error)}</Alert>
      <Button variant="secondary" onClick={() => router.invalidate()}>
        Try again
      </Button>
    </div>
  );
}

export const router = createRouter({
  routeTree: root.addChildren([index, login, forgot, reset, invite, portal.addChildren(portalChildren), admin.addChildren(adminChildren)]),
  defaultPendingComponent: () => <Spinner />,
  defaultErrorComponent: RouteError,
  defaultPreload: "intent",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
