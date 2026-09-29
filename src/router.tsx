import { lazy, Suspense } from "react";
import Index from "./pages/Index";
import NotFound from "./pages/NotFound";

// Lazy-loaded: pulls in the full seeded dataset (invoices, transactions,
// budgets...), so it should not weigh down the landing page bundle.
const Assistant = lazy(() => import("./pages/Assistant"));

export const routers = [
  {
    path: "/",
    name: "home",
    element: <Index />,
  },
  {
    path: "/assistant",
    name: "assistant",
    element: (
      <Suspense fallback={<div className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">Loading...</div>}>
        <Assistant />
      </Suspense>
    ),
  },
  /* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */
  {
    path: "*",
    name: "404",
    element: <NotFound />,
  },
];

declare global {
  interface Window {
    __routers__: typeof routers;
  }
}

window.__routers__ = routers;
