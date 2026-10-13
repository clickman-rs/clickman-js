# Clickman browser SDK

Browser-only collection for the Rust Clickman core and Clickman Cloud. ESM and
standalone script builds share a durable IndexedDB queue. The source write key is
public: it permits ingestion, never dashboard reads or administration.

The package is not published to npm yet. Build locally with `pnpm install
--frozen-lockfile && pnpm build`, serve `dist/clickman.js` from your application,
or install a tarball produced by `pnpm pack`. Do not use an unpublished CDN URL.

```js
import { createClickman, trackNavigation } from "/vendor/clickman.js";

const analytics = createClickman({
  endpoint: "https://analytics.example.com", // mount prefixes are supported
  writeKey: "your-public-web-source-key",
  consent: true, // use your application's actual consent decision
  onError: (error) => console.warn(error.message),
  onDrop: (count, reason) => console.warn("Analytics dropped", count, reason),
});

await analytics.track("product_viewed", { product_id: "product_42" });
await analytics.identify("opaque_user_42"); // never use email, phone, or a name
await analytics.track("checkout_completed", { plan: "paid" });
await analytics.flush();

// Optional, explicitly enabled. Remove on unmount; URLs omit query and hash.
const stopNavigation = trackNavigation(analytics);
// stopNavigation(); await analytics.close();
```

For SvelteKit, create the client in `onMount`, call `page` from `afterNavigate`
when you want framework-driven page events, and close it on destruction. Importing
the module is safe during SSR; creating a collecting client requires browser
IndexedDB and a secure context (HTTPS, or localhost). A plain script build exposes
`window.Clickman.createClickman` from `dist/clickman.global.js`.

`track` resolves to the stored UUIDv7 message ID, or null without consent. A failed
IndexedDB write rejects the promise rather than pretending the event was stored.
`identify` writes a persistent link command; old anonymous events, the link, and
later user events are delivered in that order. Call `reset()` at logout or before
identifying a different account. Reset starts a fresh visitor without rewriting
already queued events. `setConsent(false)` clears this client's queue and visitor
identity; a request already sent to the server cannot be recalled.

Delivery is at least once. IDs remain stable after restart; server deduplication
depends on the project's raw-event retention window. One IndexedDB lease per
endpoint/write-key pair coordinates tabs; an expired lease can replay a batch
after a crash. Queue retry deadlines survive reloads. 401, 429, network failures
and 5xx retain events, with exponential jitter and `Retry-After`. 2xx acknowledges
the batch; 400/413/415 discard it. Individual server rejections are reported by
`onDrop`. Identity validation errors are permanent and reported as drops.

Defaults: 10,000 queued items, 5 MB of encoded data, 30-day expiry, 100 events per
batch, 30-second idle flush, 20-event flush trigger. Oldest events are dropped
under queue pressure; pending identity links survive pressure. Diagnostics report
drops. Unsupported or disabled IndexedDB is an error, not a silent memory queue.
No cookies, fingerprinting, IP collection, lifecycle events or automatic page
tracking are added. Sensitive properties/context are filtered before storage;
the Rust server applies its own project policy again. URL paths can still contain
personal information: use custom page properties or event names when necessary.

Project settings can restrict browser origins. Add your site's scheme + hostname

- port to `allowed_origins`. Native clients without an Origin remain supported.
  Only public batch and identify endpoints support CORS; dashboard requests use the
  host session or an explicitly authorized access key.

`pnpm test` runs shared protocol fixtures and IndexedDB delivery contracts.
`pnpm test:browser` runs real browser persistence, cancellation and script builds.
Protocol snapshots are copied from `clickman-server/protocol`; browser identity
and IndexedDB are documented extensions, not the native SQLite lifecycle schema.
